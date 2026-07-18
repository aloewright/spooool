import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const isMainModule = ({ argvPath, moduleUrl }) =>
  argvPath !== undefined &&
  pathToFileURL(realpathSync(argvPath)).href ===
    pathToFileURL(realpathSync(fileURLToPath(moduleUrl))).href;
