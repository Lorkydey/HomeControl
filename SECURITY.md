# Security

Report security issues through [GitHub private vulnerability reporting](https://github.com/Lorkydey/HomeControl/security/advisories/new). Do not put credentials or exploitable details in public issues.

The current release line is 0.2.x. Security fixes target the current version; install updates manually from Releases. Windows installers are currently unsigned.

Controller data lives in `%LOCALAPPDATA%\fr.lorkydey.homecontrol`. `lights.json` and `matter/` are private: they preserve associations and cryptographic identity. Never share them. `config.json` contains display preferences; review its names before sharing it.

Home Control exposes no HTTP control endpoint. The frontend communicates with its local Matter engine through the native host and private pipes. Access to the Windows account and app-data folder must be treated as access to the controller; there is no separate local authentication boundary.

This is a community project, not a certified Matter product. Supply app version, bulb model and a description in bug reports, without controller files, pairing codes or packet captures.
