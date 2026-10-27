# luci-app-hostconns

A Little Snitch-style LuCI page for OpenWrt that lists each LAN host's live connections, with the domain the host looked up. Find it at **Services → Host Connections**.

It is a standard LuCI app package (`luci-app-hostconns/`): one view, a menu entry and its own read-only ACL, with no backend code.

## What it shows

Connections are grouped by LAN host. The host header shows the host's name, its IPs and its MAC.

| Column | Content |
|---|---|
| Domain | The name the host looked up through the router's dnsmasq. For a CNAME, it shows the name the host asked for, not the CDN target. If no lookup is in the log, it shows the remote's reverse DNS name in *italics*, or `–` when there is none. |
| Remote | The remote IP, linked to `https://ipinfo.io/<ip>`. |
| Protocol | TCP, UDP, ICMP, … |
| Port | The remote port. |
| Transfer | Bytes in both directions. When several connections share protocol, remote IP and port they are merged into one row, shown as `(N×)`. |

Filters:

- **Host, Host IP, Host MAC:** case-insensitive substring match.
- **Remote regex:** case-insensitive regex on the domain, for example `samba|google`. `^$` shows rows without one.
- **Remote Port:** exact match.

The table refreshes at LuCI's poll interval.

Some connections are hidden on purpose:

- connections to the router itself;
- connections from addresses the router doesn't know as a LAN host;
- hosts with no remaining connections.

## Requirements

On vanilla OpenWrt (checked against 25.12) everything below is already in place except query logging:

- `luci-base`, `rpcd-mod-rrdns` (both part of the default LuCI install, and declared as package dependencies)
- dnsmasq as the DNS server
- `net.netfilter.nf_conntrack_acct=1`, needed for Transfer. It is the OpenWrt default.
- **dnsmasq query logging** ("Log queries" in LuCI's DNS settings). You have to enable this yourself:

  ```sh
  uci set dhcp.@dnsmasq[0].logqueries=1
  uci commit dhcp
  service dnsmasq restart
  ```

  Without it, Domain falls back to reverse DNS only.

## Install

As a package, built from `luci-app-hostconns/` in an OpenWrt SDK or buildroot with the LuCI feed, it installs like any other `luci-app-*`.

For development, from a machine with ssh access to the router:

```sh
make install                          # default ROUTER=root@10.0.0.1; also reloads rpcd for the ACL
make install ROUTER=root@192.168.1.1
make uninstall
```

After the first install or any change to the menu entry, **log out and back in**. LuCI keeps the menu cached per login session. After a view-only update, a hard refresh (Ctrl+Shift+R) is enough.

sysupgrade replaces the root filesystem, so both a `make install` and an installed package are lost. Re-run `make install` or reinstall the package afterwards, or build it into the image (e.g. with Attended Sysupgrade).

## Limitations

- **Domains only cover lookups still in the system log.** With `logqueries=1` the log fills quickly: the default 128 KB covered about 80 s on a busy home network. Long-lived connections opened earlier fall back to reverse DNS. To keep more history, raise `system.@system[0].log_size`, at the cost of RAM. While the page is open, a name stays known for as long as its remote IP has live connections.
- **Some traffic never uses DNS**, so it can only get a reverse DNS name:
  - STUN and VPN probes such as Tailscale on UDP 3478, which go straight to IPs;
  - broadcast and multicast;
  - apps with hard-coded IPs.
- **The router has to see the DNS query.**

  | Setup | Domains |
  |---|---|
  | dnsmasq forwards to a local proxy (https-dns-proxy, stubby, NextDNS CLI) | Full, per host |
  | AdGuard Home in front of dnsmasq | Partial: dnsmasq sees only AdGuard's cache misses, all coming from the router, so only the "anyone's lookup of this IP" fallback works |
  | AdGuard Home or Pi-hole replaces dnsmasq on :53, or runs on another LAN machine | Reverse DNS only |
  | Devices using their own encrypted DNS (Android Private DNS, browser secure DNS, iCloud Private Relay) | Reverse DNS only |

  A hard-coded plain-DNS resolver, such as a TV using 8.8.8.8, can be caught by DNAT'ing port 53 to the router.
- **Clicking a Remote link sends that IP to ipinfo.io.** The link uses `rel="noreferrer"`, so your router URL is not sent.

## Access

The page has its own ACL group, `luci-app-hostconns`, which grants read-only access to:

- the connection list (`luci.getConntrackList`);
- host hints (`luci-rpc.getHostHints`);
- router addresses (`luci-rpc.getNetworkDevices`);
- reverse DNS (`network.rrdns.lookup`);
- the system log (`log.read`). This is the whole syslog, including every LAN host's DNS queries, so grant it only to users who may see that.

## Development

```sh
make check    # node check.js: runs the view against mocked LuCI and synthetic router data
```

Requires a recent Node. There are no dependencies and no build step. `AGENTS.md` covers the architecture, conventions, and the upstream ESLint, translation-template and SDK-build checks.
