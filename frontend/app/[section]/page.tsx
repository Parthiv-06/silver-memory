import { notFound } from "next/navigation";
import { SECTIONS, findSection } from "@/lib/sections";
import { SectionPage } from "@/components/section-page";

export const dynamicParams = false;

export function generateStaticParams() {
  return SECTIONS.map(({ slug }) => ({ section: slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ section: string }> }) {
  const section = findSection((await params).section);
  return { title: section ? `${section.title} · Working Volumes` : "Working Volumes" };
}

export default async function Page({ params }: { params: Promise<{ section: string }> }) {
  const section = findSection((await params).section);
  if (!section) notFound();
  return <SectionPage slug={section.slug} />;
}
