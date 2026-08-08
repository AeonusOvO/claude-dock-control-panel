# Third-party notices

ClaudeDock is licensed under Apache-2.0. Third-party packages retain their own copyrights and
licenses; the project license does not replace them.

The application is built from the dependency graph recorded in `package-lock.json`. Direct runtime
dependencies include Electron ecosystem packages, xterm.js, Shiki, Marked, KaTeX, Mermaid, Plotly,
D3, Fontsource packages and node-pty. Their package metadata and license files are distributed under
`node_modules` during development and, where bundled by Electron Builder, inside the application
package.

The complete generated package/version inventory and reproduced license/NOTICE texts are distributed
as `THIRD_PARTY_LICENSES.txt`. Regenerate it from the locked Windows x64 dependency tree with
`npm run generate:licenses`; CI rejects a stale file with `npm run check:licenses`.

`standardwebhooks@1.0.0` is a documented upstream metadata exception: its npm package declares MIT
but omits a license file, while the exact published `gitHead` points to an Apache-2.0 repository
license. The generated inventory preserves the npm declaration, exact source provenance and both
license texts instead of silently discarding either representation.

Before each public release, maintainers must:

1. run `npm ci` from the committed lockfile;
2. review direct and transitive dependency license metadata;
3. retain any license or NOTICE files required by bundled dependencies; and
4. stop the release if a dependency's license is missing, incompatible, or requires an obligation
   the release does not satisfy.

ClaudeDock does not bundle CLIProxyAPI in its installer and does not link against it. Starting with
4.3.0, an explicit user action can make ClaudeDock download a separately released Windows x64 build
from the upstream `router-for-me/CLIProxyAPI` GitHub repository, verify the release path, byte size
and GitHub-provided SHA-256 digest, and launch it as an independent loopback-only process. CLIProxyAPI
is licensed separately under the MIT License and retains its upstream copyright and notices:
<https://github.com/router-for-me/CLIProxyAPI>.

The downloaded executable, its configuration and its OpenAI authorization files live under the
current user's ClaudeDock application-data directory; they are not covered by ClaudeDock's
Apache-2.0 license. Users can remove those managed files after fully exiting ClaudeDock. ClaudeDock
may also connect to a user-configured external HTTP or SOCKS5 application proxy, but those
independent tools and services are not part of this distribution.
