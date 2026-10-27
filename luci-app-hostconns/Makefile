# This is free software, licensed under the Apache License, Version 2.0 .

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI live connections per LAN host with looked-up domains
LUCI_DEPENDS:=+luci-base +rpcd-mod-rrdns
LUCI_PKGARCH:=all

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=pentago <0xdzhi@pm.me>

include ../../luci.mk

# call BuildPackage - OpenWrt buildroot signature
