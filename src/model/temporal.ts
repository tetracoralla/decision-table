const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isStrictDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function parseStrictDatetime(value: string): number | undefined {
  const match = DATETIME_PATTERN.exec(value);
  if (!match || !isStrictDate(`${match[1]}-${match[2]}-${match[3]}`)) return undefined;

  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return undefined;

  const offset = match[8] as string;
  if (offset !== "Z") {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return undefined;
  }

  const epochMilliseconds = Date.parse(value);
  return Number.isFinite(epochMilliseconds) ? epochMilliseconds : undefined;
}

export function isStrictDatetime(value: string): boolean {
  return parseStrictDatetime(value) !== undefined;
}

export function parseStrictDate(value: string): number | undefined {
  if (!isStrictDate(value)) return undefined;
  const epochMilliseconds = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(epochMilliseconds) ? epochMilliseconds : undefined;
}
