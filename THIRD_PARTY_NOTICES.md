# Third-party notices

ClaudeDock is licensed under Apache-2.0. Third-party packages retain their own copyrights and
licenses; the project license does not replace them.

The application is built from the dependency graph recorded in `package-lock.json`. Direct runtime
dependencies include Electron ecosystem packages, xterm.js, Shiki, Marked, KaTeX, Mermaid, Plotly,
D3, Fontsource packages and node-pty. Their package metadata and license files are distributed under
`node_modules` during development and, where bundled by Electron Builder, inside the application
package.

Before each public release, maintainers must:

1. run `npm ci` from the committed lockfile;
2. review direct and transitive dependency license metadata;
3. retain any license or NOTICE files required by bundled dependencies; and
4. stop the release if a dependency's license is missing, incompatible, or requires an obligation
   the release does not satisfy.

ClaudeDock 4.0.0 does not bundle, download, launch, or link Xray-core or v2rayN. It may connect to a
user-configured external HTTP or SOCKS5 proxy, but those independent tools and services are not part
of this distribution.
