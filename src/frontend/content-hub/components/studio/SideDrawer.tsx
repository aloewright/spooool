// Project workspace navigation drawer — ported from
// studio/apps/web/client/components/studio/SideDrawer.tsx.
//
// Changes vs the studio source:
//   - Only the PROJECT drawer (SideDrawer) is ported. The studio file also
//     exported BlogSideDrawer / ScriptSideDrawer, whose targets (/blogs/$id,
//     /scripts/$id) aren't in spooool's route tree — those land with the blog/
//     script workspaces in a later PR. Dropping them keeps this PR to the book
//     project shell and avoids referencing unregistered routes.
//   - All navigation is /studio-absolute. Cross-route navigation uses plain
//     <a href> (the same pattern ContentHubHome already uses) rather than the
//     typed <Link>, because the hrefs are runtime strings and several targets
//     (marketplace / voice / book) are PR-4 routes not yet in the typed tree.
//     Same-route in-app links (canvas/outline) still resolve; PR-4 targets
//     404 gracefully until registered.
//   - Export still POSTs the same /api/v1/projects/:id/export and then sends the
//     author to /studio/$projectId/book (PR-4); navigated untyped so it compiles
//     against the current route tree.
//   - Session + auth come from the content-hub api (api.maybeMe) exactly as in
//     the studio source; SettingsPanel is the spooool-stubbed copy.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate } from '@tanstack/react-router';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Download,
  Home,
  ListTree,
  Mic2,
  PanelLeftClose,
  Plus,
  Settings,
  Share2,
  Store,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, queryKeys } from '../../lib/api';
import { setDrawerLayout, useDrawerLayout } from '../../lib/drawer-layout';
import { SettingsPanel } from './SettingsPanel';

export type StudioSection = 'outline' | 'marketplace' | 'voice' | 'book';

type DrawerItem = { key: string; label: string; icon: React.ReactNode; href: string };

const iconCls = 'size-4 shrink-0';

// Below lg the drawer floats over the page content, so dismiss it once a
// destination is picked instead of leaving it covering the new page.
function closeDrawerOnMobile() {
  if (typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches) {
    setDrawerLayout({ open: false });
  }
}

export function SideDrawer({
  projectId,
  current,
}: {
  projectId: string;
  current?: StudioSection;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const active = current ?? sectionFromPathname(location.pathname, projectId);

  const exportMutation = useMutation({
    mutationFn: () => api.startBookExport(projectId, { formats: ['epub', 'pdf'] }),
    // The book workspace (/studio/$projectId/book) lands in PR-4; navigate
    // untyped so this compiles against the current (canvas/outline) route tree.
    onSuccess: () =>
      void navigate({
        to: `/studio/${projectId}/book`,
      } as unknown as Parameters<typeof navigate>[0]),
  });

  return (
    <DrawerShell
      quickLinks={[
        { key: 'home', label: 'Home', icon: <Home className={iconCls} />, href: '/studio' },
        {
          key: 'new',
          label: 'New book',
          icon: <Plus className={iconCls} />,
          href: '/studio/compose',
        },
      ]}
      groupLabel="This book"
      sections={[
        {
          key: 'outline',
          label: 'Outline',
          icon: <ListTree className={iconCls} />,
          href: `/studio/${projectId}/outline`,
        },
        {
          key: 'marketplace',
          label: 'Marketplace',
          icon: <Store className={iconCls} />,
          href: `/studio/${projectId}/marketplace`,
        },
        {
          key: 'voice',
          label: 'Voice',
          icon: <Mic2 className={iconCls} />,
          href: `/studio/${projectId}/voice`,
        },
        {
          key: 'book',
          label: 'Book',
          icon: <BookOpen className={iconCls} />,
          href: `/studio/${projectId}/book`,
        },
      ]}
      activeKey={active}
      exportPending={exportMutation.isPending}
      onExport={() => exportMutation.mutate()}
    />
  );
}

function DrawerShell({
  quickLinks,
  groupLabel,
  sections,
  activeKey,
  exportPending,
  onExport,
}: {
  quickLinks: DrawerItem[];
  groupLabel: string;
  sections: DrawerItem[];
  activeKey: string;
  exportPending: boolean;
  onExport: () => void;
}) {
  const { open, collapsed, setOpen, setCollapsed } = useDrawerLayout();
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shareLabel, setShareLabel] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const session = useQuery({ queryKey: queryKeys.me(), queryFn: api.maybeMe });
  const user = session.data?.user;
  const email = user?.email ?? '';
  const displayName = user?.name?.trim() || email;
  const initial = displayName ? displayName.charAt(0).toUpperCase() : '·';
  const plan = user?.plan ? `${user.plan} plan` : 'Signed in';

  function handleShare() {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard
        .writeText(window.location.href)
        .then(() => setShareLabel('Copied!'))
        .catch(() => setShareLabel('Copy failed'));
    }
  }

  useEffect(() => {
    if (!shareLabel) return;
    const id = window.setTimeout(() => setShareLabel(null), 2000);
    return () => window.clearTimeout(id);
  }, [shareLabel]);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointer(e: PointerEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    window.addEventListener('pointerdown', onPointer);
    return () => window.removeEventListener('pointerdown', onPointer);
  }, [menuOpen]);

  if (!open) return null;

  if (collapsed) {
    return (
      <>
        <aside
          aria-label="Navigation"
          className="-translate-y-1/2 fixed top-1/2 left-4 z-30 flex flex-col items-center gap-1 rounded-3xl bg-neutral-950/95 p-2 text-neutral-200 shadow-2xl ring-1 ring-white/5 backdrop-blur transition-all duration-300"
        >
          <Tooltip label="Expand navigation">
            <button
              aria-label="Expand navigation"
              className="grid size-8 place-items-center rounded-full hover:bg-white/10"
              onClick={() => setCollapsed(false)}
              type="button"
            >
              <ChevronRight className={iconCls} />
            </button>
          </Tooltip>

          <div className="my-1 h-px w-6 bg-white/10" />

          {quickLinks.map((link) => (
            <IconLink key={link.key} to={link.href} label={link.label} icon={link.icon} />
          ))}

          <div className="my-1 h-px w-6 bg-white/10" />

          {sections.map((section) => (
            <IconSectionLink
              key={section.key}
              to={section.href}
              label={section.label}
              icon={section.icon}
              active={activeKey === section.key}
            />
          ))}

          <div className="my-1 h-px w-6 bg-white/10" />

          <Tooltip label={displayName || 'Account'}>
            <button
              aria-label="Open user menu"
              className="grid size-8 place-items-center rounded-md bg-emerald-500/20 font-semibold text-emerald-300 text-xs hover:bg-emerald-500/30"
              onClick={() => setMenuOpen((v) => !v)}
              type="button"
            >
              {initial}
            </button>
          </Tooltip>

          <Tooltip label="Close navigation">
            <button
              aria-label="Close navigation"
              className="grid size-8 place-items-center rounded-full hover:bg-white/10"
              onClick={() => setOpen(false)}
              type="button"
            >
              <PanelLeftClose className={iconCls} />
            </button>
          </Tooltip>
        </aside>
        {menuOpen && (
          <UserMenu
            anchor="collapsed"
            menuRef={menuRef}
            displayName={displayName}
            plan={plan}
            initial={initial}
            shareLabel={shareLabel}
            exportPending={exportPending}
            onShare={handleShare}
            onExport={() => {
              setMenuOpen(false);
              onExport();
            }}
            onSettings={() => {
              setMenuOpen(false);
              setSettingsOpen(true);
            }}
          />
        )}
        <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </>
    );
  }

  return (
    <>
      {/* Backdrop scrim: below lg the expanded drawer behaves as a slide-over. */}
      <button
        aria-label="Close navigation"
        className="fixed inset-0 z-20 cursor-default bg-neutral-950/40 lg:hidden"
        onClick={() => setOpen(false)}
        type="button"
      />
      <aside
        aria-label="Navigation"
        className="-translate-y-1/2 fixed top-1/2 left-4 z-30 flex max-h-[calc(100vh-2rem)] w-64 flex-col overflow-y-auto rounded-3xl bg-neutral-950/95 p-3 text-neutral-200 shadow-2xl ring-1 ring-white/5 backdrop-blur transition-all duration-300"
      >
        <div className="flex items-center justify-end px-2 py-1">
          <div className="flex items-center gap-1">
            <button
              aria-label="Collapse navigation"
              className="rounded-md p-1 hover:bg-white/10"
              onClick={() => setCollapsed(true)}
              type="button"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              aria-label="Close navigation"
              className="rounded-md p-1 hover:bg-white/10"
              onClick={() => setOpen(false)}
              type="button"
            >
              <PanelLeftClose className="size-4" />
            </button>
          </div>
        </div>

        <nav className="mt-4 flex flex-col gap-0.5">
          {quickLinks.map((link) => (
            <DrawerLink key={link.key} icon={link.icon} to={link.href}>
              {link.label}
            </DrawerLink>
          ))}
        </nav>

        <div className="mt-5 px-3 text-[11px] text-neutral-500 uppercase tracking-wide">
          {groupLabel}
        </div>
        <div className="mt-1 flex flex-col gap-0.5">
          {sections.map((section) => (
            <SectionLink
              key={section.key}
              to={section.href}
              icon={section.icon}
              active={activeKey === section.key}
            >
              {section.label}
            </SectionLink>
          ))}
        </div>

        <div className="flex-1" />

        <div className="relative">
          <button
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="mt-4 flex w-full items-center justify-between rounded-xl bg-white/5 px-3 py-2 text-left hover:bg-white/10"
            onClick={() => setMenuOpen((v) => !v)}
            type="button"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="grid size-7 shrink-0 place-items-center rounded-md bg-emerald-500/20 font-semibold text-emerald-300 text-xs">
                {initial}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium text-sm">
                  {user ? displayName : session.isLoading ? 'Loading…' : 'Sign in'}
                </span>
                <span className="text-[11px] text-neutral-400">{plan}</span>
              </span>
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-neutral-400" />
          </button>
          {menuOpen && (
            <UserMenu
              anchor="expanded"
              menuRef={menuRef}
              displayName={displayName}
              plan={plan}
              initial={initial}
              shareLabel={shareLabel}
              exportPending={exportPending}
              onShare={handleShare}
              onExport={() => {
                setMenuOpen(false);
                onExport();
              }}
              onSettings={() => {
                setMenuOpen(false);
                setSettingsOpen(true);
              }}
            />
          )}
        </div>
      </aside>
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}

function UserMenu({
  anchor,
  menuRef,
  displayName,
  plan,
  initial,
  shareLabel,
  exportPending,
  onShare,
  onExport,
  onSettings,
}: {
  anchor: 'collapsed' | 'expanded';
  menuRef: React.RefObject<HTMLDivElement | null>;
  displayName: string;
  plan: string;
  initial: string;
  shareLabel: string | null;
  exportPending: boolean;
  onShare: () => void;
  onExport: () => void;
  onSettings: () => void;
}) {
  const positionClass =
    anchor === 'collapsed'
      ? 'fixed bottom-4 left-20 z-40'
      : 'absolute bottom-full left-0 right-0 mb-2 z-40';
  return (
    <div
      ref={menuRef}
      role="menu"
      className={`${positionClass} flex w-56 flex-col gap-1 rounded-xl bg-neutral-900 p-1 text-neutral-100 shadow-2xl ring-1 ring-white/10`}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-emerald-500/20 font-semibold text-emerald-300 text-xs">
          {initial}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-sm">{displayName}</span>
          <span className="text-[11px] text-neutral-400">{plan}</span>
        </span>
      </div>
      <div className="my-0.5 h-px bg-white/10" />
      <MenuItem icon={<Share2 className="size-3.5" />} onClick={onShare}>
        {shareLabel ?? 'Share'}
      </MenuItem>
      <MenuItem
        icon={<Download className="size-3.5" />}
        onClick={onExport}
        disabled={exportPending}
      >
        {exportPending ? 'Exporting…' : 'Export'}
      </MenuItem>
      <MenuItem icon={<Settings className="size-3.5" />} onClick={onSettings}>
        Settings
      </MenuItem>
    </div>
  );
}

function MenuItem({
  icon,
  children,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
      role="menuitem"
      type="button"
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

function sectionFromPathname(pathname: string, projectId: string): StudioSection {
  const base = `/studio/${projectId}`;
  if (pathname === `${base}/outline` || pathname.startsWith(`${base}/outline/`)) return 'outline';
  if (pathname === `${base}/marketplace` || pathname.startsWith(`${base}/marketplace/`))
    return 'marketplace';
  if (pathname === `${base}/voice` || pathname.startsWith(`${base}/voice/`)) return 'voice';
  if (pathname === `${base}/book` || pathname.startsWith(`${base}/book/`)) return 'book';
  // Chapter editor (/studio/$id/chapters/$chId) and the bare /studio/$id (which
  // redirects to /canvas) both fall back to the outline section.
  return 'outline';
}

// Cross-route navigation uses plain <a href> with runtime-string hrefs — the
// same pattern ContentHubHome uses — because several targets (marketplace /
// voice / book) are PR-4 routes not yet in spooool's typed route tree, so the
// typed <Link to> would not compile against them.
function DrawerLink({
  icon,
  children,
  to,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  to: string;
}) {
  return (
    <a
      className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-white/10"
      onClick={closeDrawerOnMobile}
      href={to}
    >
      {icon}
      <span>{children}</span>
    </a>
  );
}

function SectionLink({
  to,
  icon,
  active,
  children,
}: {
  to: string;
  icon: React.ReactNode;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <a
      className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition ${
        active ? 'bg-white/10 text-neutral-100' : 'text-neutral-400 hover:bg-white/5'
      }`}
      onClick={closeDrawerOnMobile}
      href={to}
    >
      {icon}
      <span className="truncate">{children}</span>
    </a>
  );
}

function IconLink({
  icon,
  to,
  label,
}: {
  icon: React.ReactNode;
  to: string;
  label: string;
}) {
  return (
    <Tooltip label={label}>
      <a
        className="grid size-8 place-items-center rounded-full text-neutral-400 hover:bg-white/10 hover:text-neutral-200"
        onClick={closeDrawerOnMobile}
        href={to}
      >
        {icon}
      </a>
    </Tooltip>
  );
}

function IconSectionLink({
  to,
  label,
  icon,
  active,
}: {
  to: string;
  label: string;
  icon: React.ReactNode;
  active: boolean;
}) {
  return (
    <Tooltip label={label}>
      <a
        className={`grid size-8 place-items-center rounded-md transition ${
          active
            ? 'bg-white/10 text-neutral-100'
            : 'text-neutral-500 hover:bg-white/5 hover:text-neutral-300'
        }`}
        onClick={closeDrawerOnMobile}
        href={to}
      >
        {icon}
      </a>
    </Tooltip>
  );
}

function Tooltip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-full z-50 ml-3 whitespace-nowrap rounded-md bg-neutral-900 px-2 py-1 text-neutral-100 text-xs opacity-0 shadow-lg ring-1 ring-white/10 transition-opacity delay-150 group-hover:opacity-100">
        {label}
      </span>
    </span>
  );
}
