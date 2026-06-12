import { useDrawerLayout } from "../../lib/drawer-layout";
import { BreadcrumbPill } from "./BreadcrumbPill";
import { type BlogSection, BlogSideDrawer } from "./SideDrawer";
import { TopLeftPill } from "./TopLeftPill";

// Standard studio chrome (side drawer, reopen pill, breadcrumb) for blog
// pages, mirroring the book pages' layout.
export function BlogShell({
  blogId,
  title,
  current,
  maxWidth = "max-w-5xl",
  children,
}: {
  blogId: string;
  title: string;
  current?: BlogSection;
  maxWidth?: string;
  children: React.ReactNode;
}) {
  const drawer = useDrawerLayout();
  return (
    <div className="blog-surface relative min-h-screen bg-[#efece2] text-neutral-900 dark:bg-[#1a1a1a] dark:text-neutral-100">
      <BlogSideDrawer blogId={blogId} current={current} />
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
