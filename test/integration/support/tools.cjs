// The directory engines install the coverage collector into. The integration preload (sharedTools.mjs) installs it once into a shared
// directory for the whole suite; without the preload each fixture installs its own copy from NuGet, which under the suite's load can
// exceed the install time limit and leave a fixture without coverage.
const path=require('node:path');

/** @param {string} fallback the fixture's own directory, used when no shared one is set */
function toolsDirectory(fallback){return process.env.TESTY_INTEGRATION_TOOLS||path.join(fallback,'tools');}

module.exports={toolsDirectory};
