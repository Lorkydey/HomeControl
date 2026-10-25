# Third-party notices

Home Control's source is [MIT licensed](LICENSE). Dependencies retain their own licenses.

The installer includes Node.js and bundled JavaScript dependencies. `scripts/build-engine.mjs` copies the license for the runtime being packaged and available LICENSE/NOTICE files from packages included by the bundler. `scripts/collect-rust-licenses.mjs` records resolved Windows Rust dependencies, declared licenses and available license files. These notices are distributed under the installed `engine/licenses/` directory alongside the app's license.

Major components are [Tauri](https://github.com/tauri-apps/tauri), [Matter.js](https://github.com/matter-js/matter.js) and [Node.js](https://github.com/nodejs/node). Notices reflect the dependencies and runtime used by each build. Lockfiles record source dependency versions. Windows and Microsoft Edge WebView2 remain separate platform components and are not relicensed by Home Control.
