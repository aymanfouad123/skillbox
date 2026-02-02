import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-screen bg-black text-white font-mono selection:bg-accent selection:text-black flex flex-col items-center justify-center px-6">
      <div className="fixed inset-0 bg-[radial-gradient(circle_at_center,var(--tw-gradient-stops))] from-white/5 via-transparent to-transparent pointer-events-none" />
      <div className="relative z-10 text-center max-w-md">
        <div className="mb-8 flex justify-center">
          <div className="w-12 h-12 border border-white flex items-center justify-center">
            <span className="text-2xl font-bold text-accent">404</span>
          </div>
        </div>
        <h1 className="text-2xl font-bold tracking-tighter mb-2">
          PAGE NOT FOUND
        </h1>
        <p className="text-gray-400 text-sm mb-8">
          The page you&apos;re looking for doesn&apos;t exist or the URL is
          invalid.
        </p>
        <Link
          href="/"
          className="inline-block px-6 py-3 border border-accent text-accent hover:bg-accent hover:text-black transition-colors tracking-widest uppercase text-sm"
        >
          Back to SKILLBOX.SH
        </Link>
      </div>
    </main>
  );
}
