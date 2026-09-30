import type { Metadata } from 'next';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { Manrope, Red_Hat_Mono } from 'next/font/google';
import './global.css';

const manrope = Manrope({
  subsets: ['latin'],
  variable: '--font-manrope',
  display: 'swap',
  weight: ['400', '500', '600'],
});

const redHatMono = Red_Hat_Mono({
  subsets: ['latin'],
  variable: '--font-red-hat-mono',
  display: 'swap',
  weight: ['400', '500', '600'],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://docs.abx.io'),
  title: {
    default: 'ABX | Put it onchain',
    template: '%s · ABX',
  },
  description:
    'Launch, sell, and serve NFTs on Base and other EVM networks with the ABX CLI, SDK, or a coding agent.',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${manrope.variable} ${redHatMono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
