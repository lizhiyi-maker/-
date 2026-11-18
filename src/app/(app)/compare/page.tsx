import Link from "next/link";
import { dimensionCell } from "@/components/fit-score";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardTitle, EmptyState } from "@/components/ui/card";
import { FRESHNESS_LABEL } from "@/domain/analysis/freshness";
import { DIMENSION_KEYS, dimensionLabel, RULES_EXPERIMENTAL } from "@/domain/analysis/rules";
import { EXCLUDED_LABEL, WAITING_LABEL } from "@/domain/scoring/labels";
import { FEELING_LABEL, STAGE_LABEL } from "@/domain/people";
import { formatDateTime } from "@/lib/format";
import { getServices } from "@/server/container";
import type { CompareEntry } from "@/server/compare/service";
import { requireUser } from "@/server/session";

const MAX_SIDE_BY_SIDE = 3;

const personHref = (id: string) => `/people/${id}?tab=analysis`;

export default async function ComparePage({ searchParams }: { searchParams: Promise<{ ids?: string | string[] }> }) {
  const user = await requireUser();
  const { ids: rawIds } = await searchParams;
  const o = await getServices().compare.overview(user.id);
  const byId = new Map(o.entries.map((e) => [e.personId, e]));
  const name = (id: string) => byId.get(id)?.nickname ?? "";
  const selected = [...new Set([rawIds ?? []].flat())].map((id) => byId.get(id)).filter((e): e is CompareEntry => Boolean(e)).slice(0, MAX_SIDE_BY_SIDE);
  const knownText = (e: CompareEntry | undefined) =>
    e?.dimensions
      ? DIMENSION_KEYS.filter((k) => e.dimensions![k]?.status === "known")
          .map((k) => `${dimensionLabel(k)}：${dimensionCell(e.dimensions![k])}`)
          .join("；")
      : "";

  return (
    <section className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">对比</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          只在<strong>同一阶段</strong>的对象之间排名；不同阶段只并列展示。证据覆盖不够的对象进入“待了解”，只展示已知的维度，不会被当作低分。分数按你的偏好（版本 {o.preferenceVersion}）加权，
          <Link href="/me/preferences" className="text-primary">
            调整偏好
          </Link>
          后需要重新分析。
          {RULES_EXPERIMENTAL && <Badge tone="warn" className="ml-1.5">实验规则 {o.rulesVersion}</Badge>}
        </p>
      </div>

      {o.entries.length === 0 && <EmptyState title="还没有对象">先创建对象并导入聊天资料，分析之后就能在这里对比。</EmptyState>}

      {o.comparison.pools.map((pool) => (
        <Card key={pool.stage} data-testid={`pool-${pool.stage}`}>
          <CardTitle>{STAGE_LABEL[pool.stage]}</CardTitle>

          {pool.ranked.length > 0 && (
            <>
              <p className="mb-2 text-xs text-muted-foreground">
                按共同已知的 {pool.commonDimensions.length} 个维度（{pool.commonDimensions.map(dimensionLabel).join("、")}）比较，权重在这些维度内按你的重要程度重新计算；同分并列同名次。
              </p>
              <ol className="divide-y text-sm" data-testid="ranked-list">
                {pool.ranked.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 py-2" data-testid="ranked-item">
                    <span className="flex items-center gap-2">
                      <span className="w-6 text-center text-base font-semibold">{r.rank}</span>
                      <Link href={personHref(r.id)} className="font-medium">
                        {name(r.id)}
                      </Link>
                      {r.tied && <Badge>并列</Badge>}
                    </span>
                    <span className="font-semibold">{r.score} 分</span>
                  </li>
                ))}
              </ol>
            </>
          )}

          {pool.unranked.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm text-muted-foreground" data-testid="unranked-list">
              {pool.unranked.map((u) => (
                <li key={u.id}>
                  <Link href={personHref(u.id)} className="font-medium text-foreground">
                    {name(u.id)}
                  </Link>
                  ：这个阶段目前只有一个可比较的对象，暂不排名。
                </li>
              ))}
            </ul>
          )}

          {pool.waiting.length > 0 && (
            <div className="mt-3 border-t pt-3" data-testid="waiting-list">
              <h3 className="text-sm font-medium">待了解</h3>
              <p className="text-xs text-muted-foreground">关键证据还不够，不参与排名，也不是低分。</p>
              <ul className="mt-2 space-y-2 text-sm">
                {pool.waiting.map((w) => (
                  <li key={w.id} data-testid="waiting-item">
                    <Link href={personHref(w.id)} className="font-medium">
                      {name(w.id)}
                    </Link>
                    <Badge tone="warn" className="ml-2">
                      {WAITING_LABEL[w.reason].label}
                    </Badge>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {WAITING_LABEL[w.reason].hint}
                      {w.known.length > 0 ? ` 已知：${knownText(byId.get(w.id))}` : " 目前没有已知的维度。"}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      ))}

      {o.comparison.excluded.length > 0 && (
        <Card data-testid="excluded-list">
          <CardTitle>暂未参与排名</CardTitle>
          <ul className="divide-y text-sm">
            {o.comparison.excluded.map((x) => (
              <li key={x.id} className="py-2" data-testid="excluded-item">
                <Link href={personHref(x.id)} className="font-medium">
                  {name(x.id)}
                </Link>
                <Badge className="ml-2">{EXCLUDED_LABEL[x.reason].label}</Badge>
                <p className="mt-0.5 text-xs text-muted-foreground">{EXCLUDED_LABEL[x.reason].hint}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {o.entries.length > 0 && (
        <Card>
          <CardTitle>并列查看</CardTitle>
          <p className="mb-3 text-xs text-muted-foreground">选择对象，并列查看各维度、证据状态、阶段和你的个人好感。电脑上最多同时看 {MAX_SIDE_BY_SIDE} 个，手机上一次看两个。</p>
          <form method="get" action="/compare" className="space-y-3">
            <ul className="grid gap-2 sm:grid-cols-2">
              {o.entries.map((e) => (
                <li key={e.personId}>
                  <label className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
                    <input type="checkbox" name="ids" value={e.personId} defaultChecked={selected.some((s) => s.personId === e.personId)} className="size-4" />
                    {e.nickname}
                    <span className="text-xs text-muted-foreground">{e.stage ? STAGE_LABEL[e.stage] : "阶段未设置"}</span>
                  </label>
                </li>
              ))}
            </ul>
            <Button type="submit" variant="outline">
              并列查看所选对象
            </Button>
          </form>

          {selected.length >= 2 && (
            <div className="mt-4 overflow-x-auto" data-testid="side-by-side">
              {new Set(selected.map((s) => s.stage)).size > 1 && (
                <p className="mb-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground" data-testid="cross-stage-note">
                  所选对象处于不同阶段：这里只并列展示，不给统一名次。
                </p>
              )}
              <table className="w-full min-w-[20rem] text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2 pr-2 font-medium text-muted-foreground"> </th>
                    {selected.map((e, i) => (
                      <th key={e.personId} className={`px-2 py-2 font-semibold ${i >= 2 ? "hidden md:table-cell" : ""}`}>
                        <Link href={personHref(e.personId)}>{e.nickname}</Link>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  <Row label="阶段" entries={selected} cell={(e) => (e.stage ? STAGE_LABEL[e.stage] : "未设置")} />
                  <Row label="我的好感（不参与评分）" entries={selected} cell={(e) => (e.feeling ? FEELING_LABEL[e.feeling] : "未记录")} />
                  <Row label="报告状态" entries={selected} cell={(e) => (e.freshness ? FRESHNESS_LABEL[e.freshness].label : e.running ? "分析中" : "还没有报告")} />
                  <Row label="资料截止" entries={selected} cell={(e) => (e.snapshotAt ? formatDateTime(e.snapshotAt) : "—")} />
                  <Row
                    label="适配分"
                    entries={selected}
                    cell={(e) => (e.fit ? (e.fit.kind === "scored" ? `${e.fit.score}` : "未五维全已知，不显示") : "—")}
                    testId="row-fit"
                  />
                  {DIMENSION_KEYS.map((k) => (
                    <Row key={k} label={dimensionLabel(k)} entries={selected} cell={(e) => (e.dimensions ? dimensionCell(e.dimensions[k]) : "—")} />
                  ))}
                </tbody>
              </table>
              {selected.length > 2 && <p className="mt-2 text-xs text-muted-foreground md:hidden">手机上一次只显示前两个对象。</p>}
            </div>
          )}
        </Card>
      )}
    </section>
  );
}

function Row({ label, entries, cell, testId }: { label: string; entries: CompareEntry[]; cell: (e: CompareEntry) => string; testId?: string }) {
  return (
    <tr data-testid={testId}>
      <th scope="row" className="py-2 pr-2 text-left text-xs font-normal text-muted-foreground">
        {label}
      </th>
      {entries.map((e, i) => (
        <td key={e.personId} className={`px-2 py-2 ${i >= 2 ? "hidden md:table-cell" : ""}`}>
          {cell(e)}
        </td>
      ))}
    </tr>
  );
}
