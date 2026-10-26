# Home Control — Français

Une app Windows compacte pour piloter ses lumières Matter depuis la zone de notification. Panneau noir profond, commande globale en haut, noms et icônes des pièces, luminosité et couleurs.

[Télécharger](https://github.com/Lorkydey/HomeControl/releases/latest) · [Documentation complète](../README.md) · [Configuration](../config.example.json)

## Installer et appairer

Télécharger l’installateur Windows x64 et `SHA256SUMS.txt` depuis les Releases. L’installateur n’est pas signé. Node est embarqué ; WebView2 est téléchargé si nécessaire. L’app ne demande aucun compte cloud.

Configurer d’abord les ampoules dans leur application habituelle. Pour ajouter Home Control sans retirer cette application, ouvrir son partage Matter et générer un code temporaire. Dans Apple Maison : réglages de l’ampoule → **Activer le mode jumelage**. Cliquer ensuite sur une ampoule non appairée dans Home Control et coller ce code. Les codes imprimés ne rouvrent pas l’appairage d’un appareil déjà configuré.

Le PC et les ampoules doivent être joignables sur le même réseau local, avec IPv6 et multicast. Les lumières Thread nécessitent un routeur de bordure Thread. Home Control ne configure pas le Wi-Fi par Bluetooth et ne change aucun réglage réseau Windows.

## Utiliser

- Cliquer sur l’ampoule dans une barre pour allumer ou éteindre.
- Glisser vers la droite pour augmenter la luminosité, vers la gauche pour la baisser. Le pourcentage apparaît pendant le geste.
- Cliquer sur la pastille pour régler blancs, RGB/HEX, teinte, saturation et palettes selon les capacités de l’ampoule. Retour ou Échap ramène aux lampes.
- La première barre, plus large et sans texte, commande toutes les lampes accessibles. Si certaines sont éteintes, elle les rallume ; si toutes sont allumées, elle les éteint toutes. Régler une pièce seule ne change pas les autres ni la consigne de luminosité globale.
- Cliquer ailleurs masque le panneau. L’icône le rouvre sans relancer les connexions. Son menu permet de renommer, d’ouvrir la configuration et de quitter.

Les animations respectent la réduction des mouvements Windows. Les premières connexions peuvent prendre quelques secondes. Les scènes animées ou musicales propres aux fabricants ne sont pas proposées ici.

## Configurer

Le fichier est créé automatiquement dans `%LOCALAPPDATA%\fr.lorkydey.homecontrol\config.json`. Ouvrir **Ouvrir la configuration** via le clic droit sur l’icône, quitter l’app, modifier et enregistrer, puis relancer. L’[exemple](../config.example.json) et le [schéma](../config.schema.json) sont disponibles dans le dépôt. Une copie du schéma est créée à côté du fichier utilisateur.

`lights` accepte 1 à 8 lampes. Chaque entrée a un `id` stable, un `name` de 1 à 40 caractères et une `icon` parmi `bulb`, `bed`, `sofa`, `kitchen`, `desk`, `sun`. `window.width` va de 280 à 480 px, `window.margin` de 0 à 32 px. `window.hideOnBlur` active ou désactive le masquage au clic extérieur.

**Ne pas changer l’`id` d’une lampe appairée.** L’ordre, le nom et l’icône peuvent changer. Retirer une entrée la masque sans effacer son appairage ; remettre le même `id` la retrouve. Les installations antérieures migrent sans réappairage.

`config.json` contient les préférences d’affichage. En revanche, **`lights.json` et `matter/` sont privés** : ils portent l’association et l’identité du contrôleur. Ne jamais publier le dossier de données ni le joindre à un ticket. Le supprimer obligerait à partager les lampes à nouveau.

Pour les LED locales, ajouter les entrées `source: "logitech"` (clavier RGB touche par touche via G HUB) et `source: "aura"` (LED internes du PC via Aura Sync) de [l’exemple RGB](../config.rgb.example.json), en conservant les lampes et leurs identifiants, puis relancer. Une entrée par source, toujours huit lumières maximum. G HUB et/ou Armoury Crate doivent être installés et actifs. Marche/arrêt, luminosité et couleur uniforme sont disponibles ; l’état initial est inconnu, puis l’app affiche ses dernières commandes. Les effets du fabricant reprennent à la fermeture. Un autre logiciel RGB ou l’Éclairage dynamique Windows peut prendre la priorité. Voir les [détails et limites](../README.md#keyboard-and-pc-leds-windows).

Pour compiler et vérifier le projet, suivre [les instructions de développement](../README.md#develop-and-validate). Projet sous licence MIT ; les dépendances gardent leurs licences.
