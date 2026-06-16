import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">Cortex Console</h1>
      <p className="mt-2 text-sm opacity-80">Atlas workbench shell.</p>
      <nav className="mt-6">
        <Link className="text-[var(--color-accent-green)] underline" href="/cac">
          CAC
        </Link>
      </nav>
    </main>
  );
}
