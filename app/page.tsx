export default function Home() {
  return (
    <main className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="flex h-16 shrink-0 items-center justify-between border-b px-6 sm:px-8">
        <div className="flex items-center gap-3">
          <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
          <span className="text-sm font-semibold tracking-[-0.005em]">
            Product Studio
          </span>
        </div>
        <span className="text-xs font-medium text-muted-foreground">
          Foundation · Local
        </span>
      </header>

      <section className="flex flex-1 items-center px-6 py-16 sm:px-8 lg:px-16">
        <div className="w-full max-w-2xl">
          <div className="mb-8 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <span className="size-2 rounded-full bg-success" aria-hidden="true" />
            <span>Foundation ready</span>
          </div>

          <h1 className="max-w-xl text-[22px] leading-[1.25] font-semibold tracking-[-0.01em]">
            Durable workspace foundation
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
            Product work is stored in portable files. The local index is only a
            projection and can be rebuilt whenever needed.
          </p>

          <dl className="mt-10 border-y">
            <div className="grid gap-1 border-b py-4 sm:grid-cols-[9rem_1fr] sm:gap-6">
              <dt className="text-xs font-medium text-muted-foreground">Files</dt>
              <dd className="text-sm">Source of truth</dd>
            </div>
            <div className="grid gap-1 border-b py-4 sm:grid-cols-[9rem_1fr] sm:gap-6">
              <dt className="text-xs font-medium text-muted-foreground">SQLite</dt>
              <dd className="text-sm">Rebuildable local projection</dd>
            </div>
            <div className="grid gap-1 py-4 sm:grid-cols-[9rem_1fr] sm:gap-6">
              <dt className="text-xs font-medium text-muted-foreground">API</dt>
              <dd className="text-sm">Local Node runtime</dd>
            </div>
          </dl>
        </div>
      </section>
    </main>
  );
}
