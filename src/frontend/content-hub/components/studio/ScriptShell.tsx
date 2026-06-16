// Standard studio chrome (side drawer, reopen pill, breadcrumb) for script
// pages — ported from studio/apps/web/client/components/studio/ScriptShell.tsx.
//
// Verbatim aside from the import paths (../../lib, ./*) which already match the
// spooool content-hub layout. The drawer/pill/breadcrumb it composes are the
// spooool-ported copies; ScriptSideDrawer was added to SideDrawer.tsx in PR-5.
import type { JSX } from 'react';
import { useDrawerLayout } from '../../lib/drawer-layout';
import { BreadcrumbPill } from './BreadcrumbPill';
import { type ScriptSection, ScriptSideDrawer } from './SideDrawer';
import { TopLeftPill } from './TopLeftPill';

export function ScriptShell({
  scriptId,
  title,
  current,
  maxWidth = 'max-w-5xl',
  children,
}: {
  scriptId: string;
  title: string;
  current?: ScriptSection;
  maxWidth?: string;
  children: React.ReactNode;
}): JSX.Element {
  const drawer = useDrawerLayout();
  return (
    <div className="script-surface relative min-h-screen bg-[#efece2] text-neutral-900 dark:bg-[#1a1a1a] dark:text-neutral-100">
      <ScriptSideDrawer current={current} scriptId={scriptId} />
      <TopLeftPill />
      <BreadcrumbPill showTimer={false} title={title} />
      <main
        className={`px-6 pt-28 pb-20 transition-[padding] ${
          drawer.open ? (drawer.collapsed ? 'lg:pl-[5rem]' : 'lg:pl-[19rem]') : ''
        }`}
      >
        <section className={`mx-auto ${maxWidth} pb-8`}>{children}</section>
      </main>
    </div>
  );
}
