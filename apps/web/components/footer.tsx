import Link from "next/link";

export function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-8 text-xs text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
        <p className="max-w-2xl leading-relaxed">
          <span className="font-medium text-fg">FairPlay is a demonstration MVP.</span> All fixtures are fictional demo data, all tokens are valueless
          testnet mUSDC, and results come from an admin-attested mock oracle. Nothing here is real-money gambling.
        </p>
        <div className="flex gap-4">
          <Link href="/transparency" className="hover:text-fg">Trust assumptions</Link>
          <Link href="/admin" className="hover:text-fg">Admin</Link>
        </div>
      </div>
    </footer>
  );
}
