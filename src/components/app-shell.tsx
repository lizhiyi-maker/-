"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, ClipboardList, UserRound, Users, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Mascot } from "@/components/theme/mascot";

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "对象", icon: Users },
  { href: "/compare", label: "对比", icon: BarChart3 },
  { href: "/records", label: "记录", icon: ClipboardList },
  { href: "/me", label: "我的", icon: UserRound },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

function NavItems({ pathname, variant }: { pathname: string; variant: "side" | "bottom" }) {
  return NAV.map(({ href, label, icon: Icon }) => (
    <Link key={href} href={href} aria-current={isActive(pathname, href) ? "page" : undefined} className={cn("nav-item", `nav-item--${variant}`)}>
      <span className="nav-icon">
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="nav-label">{label}</span>
    </Link>
  ));
}

/** 应用外壳：电脑端悬浮侧栏（带吉祥物“团团”），手机端悬浮胶囊底栏。样式见 globals.css 的“糖果云朵”部分。 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="shell shell-a mx-auto flex min-h-dvh max-w-6xl">
      <aside className="shell-a-aside hidden w-56 shrink-0 md:block">
        <Link href="/" className="brand" aria-label="关系工作台首页">
          <Mascot size={52} />
          <span>关系工作台</span>
        </Link>
        <nav aria-label="主导航" className="mt-5 space-y-2">
          <NavItems pathname={pathname} variant="side" />
        </nav>
        <p className="aside-tip">小提示：先记下你们聊过的事，再让团团帮你理一理～</p>
      </aside>
      <main className="shell-main min-w-0 flex-1 px-4 pb-28 pt-4 md:px-8 md:pb-8 md:pt-8">{children}</main>
      <nav aria-label="底部导航" className="shell-bottom shell-bottom-a grid grid-cols-4 md:hidden">
        <NavItems pathname={pathname} variant="bottom" />
      </nav>
    </div>
  );
}
