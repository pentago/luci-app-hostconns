ROUTER ?= root@10.0.0.1
PKG := luci-app-hostconns
VIEW := /www/luci-static/resources/view/hostconns.js
MENU := /usr/share/luci/menu.d/$(PKG).json
ACL := /usr/share/rpcd/acl.d/$(PKG).json

check:
	node check.js

install:
	ssh $(ROUTER) 'cat > $(VIEW)' < $(PKG)/htdocs$(subst /www,,$(VIEW))
	ssh $(ROUTER) 'cat > $(ACL)' < $(PKG)/root$(ACL)
	ssh $(ROUTER) 'cat > $(MENU) && rm -f /tmp/luci-indexcache* && service rpcd reload' < $(PKG)/root$(MENU)

uninstall:
	ssh $(ROUTER) 'rm -f $(VIEW) $(MENU) $(ACL) /tmp/luci-indexcache* && service rpcd reload'

.PHONY: check install uninstall
