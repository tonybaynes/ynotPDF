/**
 * utif finds its inflate as `require("pako")` under Node and as `self.pako` everywhere else. A
 * bundled ES module has neither unless we put it there — so this runs before utif is imported
 * (ES imports evaluate in order) and puts pako where utif looks for it. Deflate-compressed TIFFs
 * would otherwise decode as garbage in the renderer and its Worker.
 */

import * as pako from 'pako';

const scope = globalThis as { pako?: unknown };
scope.pako ??= pako;
