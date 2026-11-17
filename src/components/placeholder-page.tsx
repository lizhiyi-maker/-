export function PlaceholderPage({ title, note }: { title: string; note: string }) {
  return (
    <section>
      <h1 className="text-xl font-semibold">{title}</h1>
      <div className="mt-4 rounded-lg border border-dashed bg-card p-6 text-sm text-muted-foreground">{note}</div>
    </section>
  );
}
