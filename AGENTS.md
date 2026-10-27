# Repository Guidelines

## Project Overview

`luci-app-hostconns`: LuCI page **Services → Host Connections** for OpenWrt. A Little Snitch-style list of each LAN host's live connections, with the domain the host looked up. It is a standard `luci.mk` package aimed at upstream openwrt/luci (`applications/luci-app-hostconns`): one JS view, a menu entry and an ACL, with no backend code.

## Architecture & Data Flow

There is one view file with no `load()`. All data arrives through `poll.add(() => update(ui))`, which runs at LuCI's global poll interval.

```
update(ui): Promise.all of 4 RPCs (each wrapped in L.resolveDefault)
  ├─ luci.getConntrackList       → connections (original tuple)
  ├─ luci-rpc.getHostHints       → hosts by MAC: name, ipaddrs, ip6addrs
  ├─ luci-rpc.getNetworkDevices  → router's own addresses (Set `router`)
  └─ log.read(false)             → syslog snapshot → learnDomains()
→ merge into devices[] → prune domains/ptr to live remotes → rebuild <datalist>s only if listsKey changed → draw(ui)
→ network.rrdns.lookup(addrs, 5000, 1000) for remotes with no logged domain → ptr{} → draw(ui) again
draw(ui): filter + sort → ui.table.replaceChildren(header, ...rows)
```

### Merge rules in `update`
- **Hosts:** a host's addresses are its hint IPs minus router addresses. Hosts left with no IPs are skipped, and so are hosts with no flows.
- **Dropped connections:** a connection is dropped if `src` is not a known host IP, or if `dst` is a router address (for example DNS to `:53`).
- **Flow key:** `` `${layer4} ${dst} ${dport}` ``. The source port is ignored, so parallel connections merge into one row: `count++` and `bytes +=`. Rows show `(N×)`.
- **Domain lookup:** `domains[`${src}|${dst}`] || domains[dst]`. The per-client lookup comes first, then any client's lookup of that IP (last write wins). The cross-host fallback is deliberate: it names traffic from devices with hardcoded DNS.
- **Reverse-DNS fallback:** if neither lookup exists, `draw` uses `ptr[dst]` (reverse DNS, shown in `<em>`). `ptr` stores `''` for misses, so each IP is asked once while it stays live.
- **Cache pruning:** after the conntrack loop, `domains` and `ptr` entries whose remote IP has no live connection are deleted. A name survives its log line only while the remote stays connected, and both caches stay bounded by the conntrack table.

### Domain learning in `learnDomains`
- **Line format:** the `dnsLine` regex parses dnsmasq `logqueries=1` lines, of the form `<id> <client>/<port> query[..]|reply|cached <name> from|is <value>`.
- **CNAME handling:** `asked[id]` holds the name the client queried. A reply to that id records the queried name, not the CNAME target.
- **Skipped replies:** only replies whose value is an IP count, so `<CNAME>` and `NXDOMAIN` lines are skipped.
- **Re-parsing:** the whole log is re-parsed on every poll.

### UI and state
- **Module-level state:** `domains`, `ptr`, `filters`, `devices`, `listsKey`. There are no classes.
- **Filters:**
  - Name, IP and MAC: case-insensitive substring matches.
  - Port: an exact match on the remote port.
  - Domain: a case-insensitive `RegExp` over the logged or reverse-DNS name, so `^$` selects rows with neither. An invalid regex adds `cbi-input-invalid` and disables the domain filter.
- **Columns:** Domain | Remote (bare IP, linked to `https://ipinfo.io/<ip>`) | Protocol | Port | Transfer. Host header rows use `colspan: 5`. Transfer is the sum of both directions; `conntrack_list()` adds the per-direction `bytes=`.
- **Save buttons:** `handleSave`, `handleSaveApply` and `handleReset` are set to `null`, which hides LuCI's Save/Reset buttons.

## Key Directories

`luci-app-hostconns/` is the package directory that gets copied into `openwrt/luci/applications/`. Everything else (`check.js`, the dev `Makefile`, the docs) is repo-only tooling.

| Path | Installs to | Purpose |
|---|---|---|
| `luci-app-hostconns/Makefile` | — | `luci.mk` package definition |
| `luci-app-hostconns/htdocs/luci-static/resources/view/hostconns.js` | `/www/luci-static/resources/view/` | The view (menu action path `hostconns`) |
| `luci-app-hostconns/root/usr/share/luci/menu.d/` | same path | Menu entry |
| `luci-app-hostconns/root/usr/share/rpcd/acl.d/` | same path | The ACL group `luci-app-hostconns` |
| `luci-app-hostconns/po/templates/hostconns.pot` | — | Translation template; `LUCI_BASENAME` is `hostconns` |

## Development Commands

```bash
make check                               # node check.js → prints "ok" or exits 1 (default target)
make install                             # ROUTER=root@10.0.0.1 default; override: make install ROUTER=root@192.168.1.1
make uninstall
```

- **How `install` copies files:** it streams the view, ACL and menu files with `ssh $(ROUTER) 'cat > <path>' < <local>`, so the router needs no scp or sftp. It then clears `/tmp/luci-indexcache*` and runs `service rpcd reload` so a changed ACL takes effect. It does not create directories.
- **Adding a deployed file:** add a matching `ssh … cat >` line to `install` and an `rm` entry to `uninstall`. There is no glob or rsync.
- **After install:** for a view-only change, a hard-refresh (Ctrl+Shift+R) is enough. For a menu change, log out and back in, or clear site storage. `ui.menu.load()` keeps the menu via `session.setLocalData('menu', …)` per login session, so neither a hard-refresh nor clearing `/tmp/luci-indexcache*` makes it show.

### Upstream CI checks

These are run by hand against a sparse clone of openwrt/luci (`luci.mk`, `eslint.config.mjs`, `build/`). They are not wired into `make`.

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/openwrt/luci /tmp/luci
(cd /tmp/luci && git sparse-checkout set --no-cone /luci.mk /eslint.config.mjs /build/)
cp -r luci-app-hostconns /tmp/luci/applications/
cd /tmp/luci
./build/i18n-scan.pl applications/luci-app-hostconns > applications/luci-app-hostconns/po/templates/hostconns.pot   # copy back after changing _() strings
npm install --no-save eslint@9 @eslint/js @eslint/json @eslint/markdown eslint-plugin-jsdoc globals
npx eslint applications/luci-app-hostconns
```

The SDK build mirrors upstream's x86-64 test build:

```bash
docker run --rm -v /tmp/luci/applications/luci-app-hostconns:/pkg:ro openwrt/sdk:x86-64-openwrt-25.12 bash -c '
  ./setup.sh; ./scripts/feeds update base luci; cp -r /pkg feeds/luci/applications/luci-app-hostconns
  ./scripts/feeds update -i luci; ./scripts/feeds install luci-app-hostconns; make defconfig
  make package/luci-app-hostconns/compile'
```

## Code Conventions & Common Patterns

- **Language:** modern browser JS, with no build step or transpiling. LuCI's ESLint uses `ecmaVersion: 2026`. The view uses `??=`, `?.`, `flatMap`, `async`/`await`, `Set` and `replaceChildren`. Do not downgrade to ES5.
- **File header:** `'use strict';` first, then the `'require view'`, `'require poll'` and `'require rpc'` directives. `L`, `E` and `_` are LuCI globals.
- **Style:** tabs and single quotes. Names are short camelCase (`byIp`, `listsKey`, `dnsLine`). RPC declarations are `callXxx = rpc.declare({object, method, params?, expect})`.
- **DOM:** build it only with `E(tag, attrs, children)`. Event handlers go in as attributes (`input: ev => …`).
  - LuCI's `dom.append` sets `innerHTML` when given a single string child; only array children become text nodes.
  - So always pass data (host names, domains, IPs, any computed cell text) as `[value]`, never as a bare string.
- **Styling:** use only stock LuCI CSS classes (`cbi-map`, `cbi-section`, `table`/`tr`/`th`/`td`, `cbi-input-text`).
- **i18n:** every user-visible string goes through `_()`. The `–`, `×` and `·` glyphs and the data itself are not translated. After changing strings, regenerate `po/templates/hostconns.pot`. Language `.po` files come from Weblate after merge.
- **Error handling:** RPC failures degrade to empty data through `L.resolveDefault(call(), fallback)`. Bad or missing fields are coerced (`h.name || mac`, `+c.bytes || 0`, `|| []`). The only `try`/`catch` is around compiling the user's regex.
- **Access control:**
  - `root/usr/share/rpcd/acl.d/luci-app-hostconns.json` grants read-only access to exactly the five ubus methods the view calls: `luci.getConntrackList`, `luci-rpc.getHostHints`/`getNetworkDevices`, `network.rrdns.lookup` and `log.read`.
  - The menu's `depends.acl` is `["luci-app-hostconns"]`.
  - A new RPC call needs a matching grant here.
- **Dependencies:** `LUCI_DEPENDS:=+luci-base +rpcd-mod-rrdns`.
  - `luci-base` provides `luci`/`luci-rpc` through `rpcd-mod-luci`.
  - Only the `luci-light` collection pulls in `rpcd-mod-rrdns`.
  - `log` is logd, part of the base system.

## Important Files

- `luci-app-hostconns/htdocs/luci-static/resources/view/hostconns.js`: the entire app (`learnDomains`, `update`, `draw`, `render`).
- `luci-app-hostconns/root/usr/share/luci/menu.d/luci-app-hostconns.json`: menu path `admin/services/hostconns`, `order` 7, action `{type: view, path: hostconns}`.
- `luci-app-hostconns/root/usr/share/rpcd/acl.d/luci-app-hostconns.json`: the ACL.
- `luci-app-hostconns/Makefile`: the `luci.mk` package (`LUCI_TITLE`, `LUCI_DEPENDS`, `PKG_LICENSE:=Apache-2.0`).
- `check.js`: the offline check.
- `Makefile`: the dev targets `check`, `install` and `uninstall`. Variables are `ROUTER`, `PKG`, `VIEW`, `MENU` and `ACL`.
- `README.md`: the user-facing docs (requirements, install, limitations, DNS-setup compatibility). Keep it in sync with UI and behavior changes.

## Runtime/Tooling Preferences

- **Router:** OpenWrt with LuCI, and the view runs in the browser.
- **Local:** a recent Node, needed only for `make check`. Upstream checks need npm (ESLint) and Docker (SDK build); see above.
- **No repo tooling:** there is no `package.json` and nothing installed in the repo. Don't add any; run ESLint from the `/tmp/luci` clone.

## Testing & QA

`check.js` runs the real view source and has no framework or dependencies.

### How the check works
- **Loading:** it reads the view and runs it with `new Function(...Object.keys(env), src)`. `view.extend` is mocked as `o => o`, so the result is the plain object holding `render()`.
- **Mocks** (`env`):
  - `rpc.declare` returns `data['<object>.<method>']`, already unwrapped, and ignores `expect`.
  - `poll.add` stores the function, and the test calls `pollFn()` (and re-calls it after changing `data` to simulate later polls).
  - `L.resolveDefault` is `p => p`, so no fallback is applied.
  - `E` builds a fake `El` node, and `_` is the identity function.
  - `E` throws if a lone string child contains `<` or `&` (it would become `innerHTML`). The `phone<i>` host name exercises this.
- **Fake `String.prototype.format`:** it returns `${n}B`, so assertions see raw byte counts such as `150B (2×)`, not LuCI's formatted sizes.
- **Fixed DOM indexes:** the check reads `root.kids[2].kids[0].kids` as the inputs (name, ip, mac, domain, port) and `root.kids[2].kids[1]` as the table. Restructuring `render()` means updating these indexes.
- **Shared state:** filters and the caches are module state, so reset each input to `''` after setting it with `set(input, v)`. The check also leaves state behind between later polls.

### Extending it
1. **New RPC:** add `data['obj.method']` holding the unwrapped payload.
2. **New `'require x'` or global:** add a minimal stub to `env`. Without it the check fails with a `ReferenceError`.
3. **New DOM method:** add it to `El`.
4. **New behaviour:** add synthetic rows covering it and the edge case that should be hidden. Assert exact strings through `hosts()` and `flows()`, with a one-line comment saying what the group of assertions proves.

### Blind spots
- `expect` unwrapping and `resolveDefault` fallbacks are mocked away, so mistakes there only show up on the router.
- The ACL has not been exercised by a restricted (non-root) LuCI user.

## Router Prerequisites / Gotchas

- **Domain column:** needs `uci set dhcp.@dnsmasq[0].logqueries=1` (LuCI calls it "Log queries" on the DNS settings page). Without it the column only shows reverse-DNS names.
- **Domain coverage:** limited to the syslog ring buffer, set by `system.@system[0].log_size`. At 128 KB this router's log covered only about 80 s (measured 2026-10-27; dnsmasq query logging fills it fast).
- **Transfer column:** needs `net.netfilter.nf_conntrack_acct=1` (the OpenWrt default); otherwise it shows `–`.
- **Other resolvers:** lookups sent to another resolver (e.g. a hardcoded 8.8.8.8) show no domain unless port 53 is DNAT'd to the router.
- **sysupgrade:** replaces the root filesystem, so both a dev install and an installed package are lost. Re-run `make install` or reinstall the package afterwards, or build it into the image (e.g. with Attended Sysupgrade).
- **ACL changes:** rpcd assigns ACL groups to a session at login, so after installing or changing the ACL, log out of LuCI and back in. Until then the menu entry is hidden and the calls are denied.
- **Upstream PR:**
  - The commit needs a real name and a non-noreply email in the author, committer and `Signed-off-by` (FormalityCheck fails on `users.noreply.github.com`). Use the same identity as `PKG_MAINTAINER`, set as the repo-local `user.name`/`user.email`, keep the existing SSH signing key, and commit with `-s`.
  - The subject must match `luci-app-hostconns: <lowercase summary>` and stay at most 60 characters.
  - The body must not be empty.
