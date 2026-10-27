'use strict';
'require view';
'require poll';
'require rpc';

const callConntrack = rpc.declare({ object: 'luci', method: 'getConntrackList', expect: { result: [] } });
const callHostHints = rpc.declare({ object: 'luci-rpc', method: 'getHostHints', expect: { '': {} } });
const callNetDevices = rpc.declare({ object: 'luci-rpc', method: 'getNetworkDevices', expect: { '': {} } });
const callLogRead = rpc.declare({ object: 'log', method: 'read', params: ['stream'], expect: { log: [] } });
const callRrdns = rpc.declare({ object: 'network.rrdns', method: 'lookup', params: ['addrs', 'timeout', 'limit'], expect: { '': {} } });

// dnsmasq with logqueries=1: "<id> <client>/<port> query[A] <name> from <client>" / "<id> <client>/<port> reply <name> is <ip>"
const dnsLine = /^dnsmasq\[\d+\]: (\d+) (\S+?)\/\d+ (query\[\w+\]|reply|cached) (\S+) (?:from|is) (\S+)$/;
const ipAddr = /^(\d+\.){3}\d+$|^[0-9a-f]*:[0-9a-f:]+$/i;

// "<client>|<ip>" (and bare "<ip>" as fallback) -> name looked up. Seeded from the syslog ring buffer and kept while
// the remote IP has live connections, so a connection opened before that window (or resolved via another DNS server)
// shows no domain.
const domains = {};
const ptr = {}; // remote IP -> reverse DNS name ('' when none); asked once while the IP stays live
const filters = { name: '', ip: '', port: '', mac: '', domain: '' };
let devices = [];
let listsKey = '';

function learnDomains(log) {
	const asked = {};
	for (const { msg } of log) {
		const m = dnsLine.exec(msg);
		if (!m) continue;
		const [, id, client, kind, name, value] = m;
		if (kind.startsWith('query')) asked[id] = name;
		else if (ipAddr.test(value)) domains[`${client}|${value}`] = domains[value] = asked[id] || name;
	}
}

async function update(ui) {
	const [conns, hints, devs, log] = await Promise.all([
		L.resolveDefault(callConntrack(), []),
		L.resolveDefault(callHostHints(), {}),
		L.resolveDefault(callNetDevices(), {}),
		L.resolveDefault(callLogRead(false), [])
	]);
	learnDomains(log);

	const router = new Set();
	for (const d of Object.values(devs))
		for (const a of [...(d.ipaddrs || []), ...(d.ip6addrs || [])]) router.add(a.address);

	const byIp = {}, all = [];
	for (const [mac, h] of Object.entries(hints)) {
		const ips = [...(h.ipaddrs || []), ...(h.ip6addrs || [])].filter(ip => !router.has(ip));
		if (!ips.length) continue;
		const dev = { mac, name: h.name || mac, ips, flows: {} };
		all.push(dev);
		for (const ip of ips) byIp[ip] = dev;
	}

	for (const c of conns) {
		const dev = byIp[c.src];
		if (!dev || router.has(c.dst)) continue;
		const f = dev.flows[`${c.layer4} ${c.dst} ${c.dport}`] ??= {
			proto: c.layer4.toUpperCase(), dst: c.dst, dport: c.dport,
			domain: domains[`${c.src}|${c.dst}`] || domains[c.dst], count: 0, bytes: 0
		};
		f.count++;
		f.bytes += +c.bytes || 0;
	}

	// Forget remotes with no live connection, so the caches stay bounded by the conntrack table.
	const live = new Set(conns.map(c => c.dst));
	for (const k in domains) if (!live.has(k.split('|').pop())) delete domains[k];
	for (const k in ptr) if (!live.has(k)) delete ptr[k];

	devices = all.filter(d => Object.keys(d.flows).length).sort((a, b) => a.name.localeCompare(b.name));
	const key = devices.map(d => d.mac + d.name + d.ips).join();
	if (key !== listsKey) {
		listsKey = key;
		ui.lists.name.replaceChildren(...devices.map(d => E('option', { value: d.name })));
		ui.lists.ip.replaceChildren(...devices.flatMap(d => d.ips.map(ip => E('option', { value: ip }))));
		ui.lists.mac.replaceChildren(...devices.map(d => E('option', { value: d.mac })));
	}
	draw(ui);

	// Reverse DNS for remotes the DNS log can't name; drawn first so the table doesn't wait for slow lookups.
	const addrs = [...new Set(devices.flatMap(d => Object.values(d.flows)).filter(f => !f.domain && !(f.dst in ptr)).map(f => f.dst))];
	if (!addrs.length) return;
	const names = await L.resolveDefault(callRrdns(addrs, 5000, 1000), {});
	for (const ip of addrs) ptr[ip] = names[ip] || '';
	draw(ui);
}

function draw(ui) {
	const has = (value, query) => value.toLowerCase().includes(query.toLowerCase());
	let domainRe = null;
	try {
		domainRe = filters.domain ? new RegExp(filters.domain, 'i') : null;
		ui.domain.classList.remove('cbi-input-invalid');
	} catch (e) {
		ui.domain.classList.add('cbi-input-invalid');
	}

	const rows = [];
	for (const d of devices) {
		if (!has(d.name, filters.name) || !has(d.mac, filters.mac) || !d.ips.some(ip => has(ip, filters.ip))) continue;
		const flows = Object.values(d.flows).filter(f => (!domainRe || domainRe.test(f.domain || ptr[f.dst] || '')) &&
			(!filters.port || String(f.dport) === filters.port.trim()));
		if (!flows.length) continue;
		rows.push(E('tr', { class: 'tr table-titles' },
			E('th', { class: 'th', colspan: 5 }, [`${d.name} · ${d.ips.join(', ')} · ${d.mac}`])));
		for (const f of flows.sort((a, b) => b.bytes - a.bytes))
			rows.push(E('tr', { class: 'tr' }, [
				E('td', { class: 'td' }, [f.domain || (ptr[f.dst] ? E('em', { title: _('Reverse DNS') }, [ptr[f.dst]]) : E('em', {}, '–'))]),
				E('td', { class: 'td' }, E('a', { href: `https://ipinfo.io/${f.dst}`, target: '_blank', rel: 'noreferrer' }, [f.dst])),
				E('td', { class: 'td' }, [f.proto]),
				E('td', { class: 'td' }, [f.dport || '–']),
				E('td', { class: 'td' }, [(f.bytes ? '%1024.2mB'.format(f.bytes) : '–') + (f.count > 1 ? ` (${f.count}×)` : '')])
			]));
	}
	ui.table.replaceChildren(ui.table.firstElementChild,
		...(rows.length ? rows : [E('tr', { class: 'tr placeholder' }, E('td', { class: 'td' }, E('em', {}, _('No matching connections'))))]));
}

return view.extend({
	render() {
		const ui = {
			table: E('table', { class: 'table' }, E('tr', { class: 'tr table-titles' }, [
				E('th', { class: 'th' }, _('Domain')),
				E('th', { class: 'th' }, _('Remote')),
				E('th', { class: 'th' }, _('Protocol')),
				E('th', { class: 'th' }, _('Port')),
				E('th', { class: 'th' }, _('Transfer'))
			])),
			lists: { name: E('datalist', { id: 'hostconns-name' }), ip: E('datalist', { id: 'hostconns-ip' }), mac: E('datalist', { id: 'hostconns-mac' }) }
		};
		const input = (field, placeholder, list) => E('input', {
			type: 'text', class: 'cbi-input-text', placeholder, list,
			input: ev => { filters[field] = ev.target.value; draw(ui); }
		});
		ui.domain = input('domain', _('Remote regex, e.g. samba|google'));
		poll.add(() => update(ui));
		return E('div', { class: 'cbi-map' }, [
			E('h2', {}, _('Host Connections')),
			E('div', { class: 'cbi-map-descr' }, _('Active connections per LAN host. Domain is the name the host looked up through this router, read from the system log (requires "Log queries" in the DNS settings); when that lookup has left the log or went to another DNS server, the remote\'s reverse DNS name is shown in italics instead.')),
			E('div', { class: 'cbi-section' }, [
				E('div', { style: 'display:flex;flex-wrap:wrap;gap:.5em;margin-bottom:1em' }, [
					input('name', _('Host'), 'hostconns-name'),
					input('ip', _('Host IP'), 'hostconns-ip'),
					input('mac', _('Host MAC'), 'hostconns-mac'),
					ui.domain,
					input('port', _('Remote Port')),
					ui.lists.name, ui.lists.ip, ui.lists.mac
				]),
				ui.table
			])
		]);
	},
	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
