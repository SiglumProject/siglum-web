interface ParagraphRange { text: string; start: number; end: number }
interface Profile { chapters: Map<string, { pages: { paragraphs: ParagraphRange[] }[] }> }
export function createBookParagraphProfile(source: string, files: Record<string, string | Uint8Array>): Profile | null
export function getBookParagraphEdit(profile: Profile, path: string, before: string, after: string): { chapter: number; page: number; paragraph: number; before: string; after: string } | null
