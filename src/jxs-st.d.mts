// Types for the emscripten output dist/jxs-st.mjs, the single-threaded build
// (see src/abi.ts).
import type { JxsModule, JxsModuleArgs } from "./abi.js";

declare function createJxsModule(args?: JxsModuleArgs): Promise<JxsModule>;
export default createJxsModule;
