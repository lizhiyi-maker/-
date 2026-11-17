"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, ClipboardList, UserRound, Users, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "对象", icon: Users },
  { href: "/compare", label: "对比", icon: BarChart3 },
  { href: "/records", label: "记录", icon: ClipboardList },
  { href: "/me", label: "我的", icon: UserRound },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

/** 手机端底部导航，电脑端侧边导航。 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl">
      <aside className="hidden w-52 shrink-0 border-r bg-card p-4 md:block">
        <div className="mb-6 px-2 text-base font-semibold">关系工作台</div>
        <nav aria-label="主导航" className="space-y-1">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={isActive(pathname, href) ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm",
                isActive(pathname, href) ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted",
              )}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </Link>
          ))}
        </nav>
      </aside>
      <main className="min-w-0 flex-1 px-4 pb-24 pt-4 md:px-8 md:pb-8 md:pt-8">{children}</main>
      <nav
        aria-label="底部导航"
        className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-4 border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {NAV.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            aria-current={isActive(pathname, href) ? "page" : undefined}
            className={cn(
              "flex flex-col items-center gap-0.5 py-2 text-xs",
              isActive(pathname, href) ? "font-medium text-primary" : "text-muted-foreground",
            )}
          >
            <Icon className="size-5" aria-hidden />
            {label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
