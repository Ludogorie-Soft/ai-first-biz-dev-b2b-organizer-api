import { ReplyCategory } from '../types'

const POSITIVE: string[] = [
  // English
  'interested',
  'yes',
  'sure',
  'sounds good',
  "let's talk",
  'schedule',
  'demo',
  'call me',
  'more info',
  'tell me more',
  'when can',
  'available',
  'book a',
  // Bulgarian
  'интересувам се',
  'заинтересован',
  'заинтересована',
  'да',
  'добре',
  'звучи добре',
  'да поговорим',
  'да се обадим',
  'schedulirame',
  'обади ми се',
  'обадете се',
  'повече информация',
  'кажете ми повече',
  'разкажете повече',
  'кога мога',
  'кога можем',
  'наличен съм',
  'налична съм',
  'свободен съм',
  'свободна съм',
  'резервирай',
  'запази',
  'демо',
  'демонстрация',
  'презентация',
]

const NEGATIVE: string[] = [
  // English
  'not interested',
  'no thanks',
  'unsubscribe',
  'remove me',
  "don't contact",
  'do not contact',
  'stop emailing',
  'leave me alone',
  'stop bothering',
  // Bulgarian
  'не съм заинтересован',
  'не съм заинтересована',
  'не ме интересува',
  'не благодаря',
  'откажи абонамент',
  'отписване',
  'премахнете ме',
  'изтрийте ме',
  'не ме контактувайте',
  'не се обаждайте',
  'спрете да ми пишете',
  'спрете да ми изпращате',
  'не ме безпокойте',
  'оставете ме на мира',
  'не искам',
  'не ми пишете',
]

const OOO: string[] = [
  // English
  'out of office',
  'on vacation',
  'away from office',
  'will be back',
  'auto-reply',
  'automatic reply',
  'currently out',
  // Bulgarian
  'извън офиса',
  'извън офис',
  'на почивка',
  'на отпуска',
  'в отпуск',
  'в отпуска',
  'на ваканция',
  'няма да съм на разположение',
  'ще се върна',
  'автоматичен отговор',
  'автоматично съобщение',
  'в момента съм извън',
  'не съм в офиса',
  'командировка',
  'служебна командировка',
]

function categorizeReply(body: string): ReplyCategory {
  const lower = (body || '').toLowerCase()
  if (OOO.some((kw) => lower.includes(kw))) return 'out_of_office'
  if (NEGATIVE.some((kw) => lower.includes(kw))) return 'negative'
  if (POSITIVE.some((kw) => lower.includes(kw))) return 'positive'
  return 'neutral'
}

export { categorizeReply }
