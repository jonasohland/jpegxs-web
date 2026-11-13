// Types for the emscripten output dist/jxs.mjs (see src/abi.ts).
import type { JxsModule, JxsModuleArgs } from "./abi.js";

declare function createJxsModule(args?: JxsModuleArgs): Promise<JxsModule>;
export default createJxsModule;
