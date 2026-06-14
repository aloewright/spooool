import { characterArcFramework } from "./character-arc";
import { heroJourneyFramework } from "./hero-journey";
import { paasFramework } from "./paas";
import { readerTransformationFramework } from "./reader-transformation";
import { sciFiFramework } from "./sci-fi";
import type { Framework, ProjectKind } from "./shared";
import { thrillerFramework } from "./thriller";
import { truby22Framework } from "./truby-22";

export const frameworks = [
  paasFramework,
  readerTransformationFramework,
  heroJourneyFramework,
  truby22Framework,
  characterArcFramework,
  thrillerFramework,
  sciFiFramework,
] as const satisfies readonly Framework[];

export function frameworkFor(id: string | undefined, type: ProjectKind) {
  if (id) {
    const framework = frameworks.find(
      (item) => item.id === id && (item.type === type || item.type === "any"),
    );
    if (framework) return framework;
  }
  return type === "fiction" ? heroJourneyFramework : paasFramework;
}
