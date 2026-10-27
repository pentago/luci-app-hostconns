// Offline check of the view logic against mocked LuCI globals and synthetic router data: node check.js
const assert = require('node:assert/strict');
const fs = require('node:fs');

class El {
	constructor(tag, attrs, kids) {
		this.tag = tag;
		this.attrs = attrs || {};
		this.kids = [kids].flat().filter(k => k != null);
		this.classList = {
			add: c => { this.attrs.class += ` ${c}`; },
			remove: c => { this.attrs.class = this.attrs.class.replace(` ${c}`, ''); }
		};
	}
	get firstElementChild() { return this.kids[0]; }
	replaceChildren(...kids) { this.kids = kids; }
	text() { return this.kids.map(k => (k instanceof El ? k.text() : String(k))).join(' | '); }
}
String.prototype.format = function (n) { return `${n}B`; };

const data = {
	'luci-rpc.getNetworkDevices': { 'br-lan': { ipaddrs: [{ address: '10.0.0.1' }] } },
	'luci-rpc.getHostHints': {
		'AA:00:00:00:00:01': { name: 'tv', ipaddrs: ['10.0.0.12'], ip6addrs: ['fe80::1'] },
		'AA:00:00:00:00:02': { name: 'phone<i>', ipaddrs: ['10.0.0.14'] }, // client-set DHCP name with markup
		'AA:00:00:00:00:03': { name: 'idle', ipaddrs: ['10.0.0.20'] }
	},
	'log.read': [
		{ msg: 'dnsmasq[1]: 7 10.0.0.12/5000 query[A] events.cid.samba.tv from 10.0.0.12' },
		{ msg: 'dnsmasq[1]: 7 10.0.0.12/5000 reply events.cid.samba.tv is <CNAME>' },
		{ msg: 'dnsmasq[1]: 7 10.0.0.12/5000 reply edge.example.net is 1.2.3.4' },
		{ msg: 'dnsmasq[1]: 8 10.0.0.14/5001 query[A] cdn.example.com from 10.0.0.14' },
		{ msg: 'dnsmasq[1]: 8 10.0.0.14/5001 reply cdn.example.com is 5.6.7.8' },
		{ msg: 'dropbear[9]: Child connection from 10.0.0.8:50276' }
	],
	'luci.getConntrackList': [
		{ layer4: 'tcp', src: '10.0.0.12', dst: '1.2.3.4', dport: 443, bytes: 100 },
		{ layer4: 'tcp', src: '10.0.0.12', dst: '1.2.3.4', dport: 443, bytes: 50 },
		{ layer4: 'tcp', src: '10.0.0.12', dst: '5.6.7.8', dport: 443, bytes: 0 },
		{ layer4: 'udp', src: '10.0.0.12', dst: '10.0.0.1', dport: 53, bytes: 80 },
		{ layer4: 'tcp', src: '10.0.0.12', dst: '9.9.9.9', dport: 443, bytes: 10 },
		{ layer4: 'tcp', src: '10.0.0.14', dst: '5.6.7.8', dport: 443, bytes: 20 },
		{ layer4: 'udp', src: '10.0.0.14', dst: '1.1.1.1', dport: 853, bytes: 30 },
		{ layer4: 'tcp', src: 'fe80::1', dst: '2001:db8::1', dport: 443, bytes: 5 },
		{ layer4: 'tcp', src: '192.0.2.50', dst: '10.0.0.12', dport: 8008, bytes: 5 }
	],
	'network.rrdns.lookup': { '1.1.1.1': 'one.one.one.one' }
};

let pollFn;
const env = {
	rpc: { declare: o => () => Promise.resolve(data[`${o.object}.${o.method}`]) },
	view: { extend: o => o },
	poll: { add: f => { pollFn = f; } },
	L: { resolveDefault: p => p },
	// LuCI's E() sets innerHTML for a lone string child, so untrusted data must come wrapped in an array.
	E: (tag, attrs, kids) => {
		if (typeof kids === 'string' && /[<&]/.test(kids)) throw new Error(`E() would inject HTML: ${kids}`);
		return new El(tag, attrs, kids);
	},
	_: s => s
};
const src = fs.readFileSync(`${__dirname}/luci-app-hostconns/htdocs/luci-static/resources/view/hostconns.js`, 'utf8');
const view = new Function(...Object.keys(env), src)(...Object.values(env));

(async () => {
	const root = view.render();
	await pollFn();
	const [nameIn, ipIn, macIn, domainIn, portIn] = root.kids[2].kids[0].kids;
	const table = root.kids[2].kids[1];
	const set = (input, value) => input.attrs.input({ target: { value } });
	const hosts = () => table.kids.filter(r => r.kids[0]?.attrs.colspan).map(r => r.text().split(' · ')[0]);
	const flows = () => table.kids.filter(r => r.kids[0]?.tag === 'td' && r.kids.length === 5).map(r => r.text());

	// Domain is the name the client asked for, even when the IP came from a CNAME target; duplicate flows merge;
	// unknown sources, router-bound traffic and idle hosts are hidden; another client's lookup is the fallback;
	// reverse DNS names remotes the DNS log can't, and unresolvable ones stay "–".
	assert.deepEqual(hosts(), ['phone<i>', 'tv']);
	assert.deepEqual(flows(), [
		'one.one.one.one | 1.1.1.1 | UDP | 853 | 30B',
		'cdn.example.com | 5.6.7.8 | TCP | 443 | 20B',
		'events.cid.samba.tv | 1.2.3.4 | TCP | 443 | 150B (2×)',
		'– | 9.9.9.9 | TCP | 443 | 10B',
		'– | 2001:db8::1 | TCP | 443 | 5B',
		'cdn.example.com | 5.6.7.8 | TCP | 443 | –'
	]);
	// Remote links to ipinfo.io with the bare address: no port, no IPv6 brackets.
	assert.deepEqual(table.kids.filter(r => r.kids.length === 5 && r.kids[1].tag === 'td').map(r => r.kids[1].kids[0].attrs.href), [
		'https://ipinfo.io/1.1.1.1', 'https://ipinfo.io/5.6.7.8', 'https://ipinfo.io/1.2.3.4', 'https://ipinfo.io/9.9.9.9',
		'https://ipinfo.io/2001:db8::1', 'https://ipinfo.io/5.6.7.8'
	]);

	set(nameIn, 'TV');
	assert.deepEqual(hosts(), ['tv']);
	set(nameIn, '');
	set(ipIn, 'fe80::1');
	assert.deepEqual(hosts(), ['tv']);
	set(ipIn, '');
	// Port filter is an exact match on the remote port, and hosts with no matching flow disappear.
	set(portIn, '853');
	assert.deepEqual(flows(), ['one.one.one.one | 1.1.1.1 | UDP | 853 | 30B']);
	assert.deepEqual(hosts(), ['phone<i>']);
	set(portIn, '85');
	assert.equal(table.kids.at(-1).text(), 'No matching connections');
	set(portIn, '');
	set(macIn, ':02');
	assert.deepEqual(hosts(), ['phone<i>']);
	set(macIn, '');

	set(domainIn, 'SAMBA|bugsnag|one\\.one');
	assert.deepEqual(flows(), ['one.one.one.one | 1.1.1.1 | UDP | 853 | 30B', 'events.cid.samba.tv | 1.2.3.4 | TCP | 443 | 150B (2×)']);
	set(domainIn, 'samba(');
	assert.match(domainIn.attrs.class, /cbi-input-invalid/);
	assert.equal(flows().length, 6);
	set(domainIn, 'nomatch');
	assert.equal(table.kids.at(-1).text(), 'No matching connections');
	set(domainIn, '');
	assert.doesNotMatch(domainIn.attrs.class, /cbi-input-invalid/);

	// A name outlives its log line while the remote stays connected, and is forgotten once it isn't (bounded cache).
	const conns = data['luci.getConntrackList'];
	data['log.read'] = [];
	await pollFn();
	assert.ok(flows().includes('events.cid.samba.tv | 1.2.3.4 | TCP | 443 | 150B (2×)'));
	data['luci.getConntrackList'] = conns.filter(c => c.dst !== '1.2.3.4');
	await pollFn();
	data['luci.getConntrackList'] = conns;
	await pollFn();
	assert.ok(flows().includes('– | 1.2.3.4 | TCP | 443 | 150B (2×)'));

	console.log('ok');
})().catch(e => { console.error(e); process.exit(1); });
