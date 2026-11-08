/** Explicit inflected forms used in transfer messages. Not a general stemmer. */
const WORD_TO_CANON: Record<string, string> = {};

function addForms(canon: string, forms: string[]) {
  const all = [canon, ...forms];
  for (const form of all) {
    WORD_TO_CANON[form.toLowerCase().replace(/ё/g, 'е')] = canon;
  }
}

addForms('порошок', ['порошка', 'порошку', 'порошке', 'порошком', 'порошков']);
addForms('чай', ['чая', 'чаю', 'чаем', 'чае', 'чаи', 'чаёв', 'чаев']);
addForms('шампунь', ['шампуня', 'шампуню', 'шампунем', 'шампуне']);
addForms('пластырь', ['пластыря', 'пластырю', 'пластырем', 'пластыре', 'пластыри', 'пластырей']);
addForms('ұнтақ', ['ұнтағы', 'ұнтагы', 'ұнтақты', 'ұнтакты', 'ұнтақтан', 'ұнтаққа', 'ұнтақпен', 'унтак']);
addForms('шай', ['шайдан', 'шайды', 'шайға', 'шайга', 'шаймен']);

export function foldTransferProductQuery(raw: string): string {
  return String(raw || '').replace(/[\p{L}]+/gu, (word) => {
    const key = word.toLowerCase().replace(/ё/g, 'е');
    return WORD_TO_CANON[key] || word;
  });
}
