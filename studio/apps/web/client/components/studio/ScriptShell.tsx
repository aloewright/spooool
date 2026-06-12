import { useDrawerLayout } from "../../lib/drawer-layout";
import { BreadcrumbPill } from "./BreadcrumbPill";
import { type ScriptSection, ScriptSideDrawer } from "./SideDrawer";
import { TopLeftPill } from "./TopLeftPill";

// Standard studio chrome (side drawer, reopen pill, breadcrumb) for script
// pages, mirroring the blog pages' layout.
export function ScriptShell({
  scriptId,
  title,
  current,
  maxWidth = "max-w-5xl",
  children,
}: {
  scriptId: string;
  title: string;
  current?: ScriptSection;
  maxWidth?: string;
  children: React.ReactNode;
}) {
  const drawer = useDrawerLayout();
  return (
    <div className="script-surface relative min-h-screen bg-[#efece2] text-neutral-900 dark:bg-[#1a1a1a] dark:text-neutral-100">
      <ScriptSideDrawer scriptId={scriptId} current={current} />
      <TopLeftPill />
      <BreadcrumbPill showTimer={false} title={title} />
      <main
        className={`px-6 pt-28 pb-20 transition-[padding] ${
          drawer.open ? (drawer.collapsed ? "lg:pl-[5rem]" : "lg:pl-[19rem]") : ""
        }`}
      >
        <section className={`mx-auto ${maxWidth} pb-8`}>{children}</section>
      </main>
    </div>
  );
}
