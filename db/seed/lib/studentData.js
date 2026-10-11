'use strict';

// Deterministic fake registry data: the same inputs always give the same
// students, so demos and load tests are reproducible. No external faker library.

const FIRST_NAMES = [
  'Adaeze', 'Adebayo', 'Aisha', 'Amaka', 'Aminu', 'Babajide', 'Bisola', 'Chidi', 'Chiamaka', 'Chinedu',
  'Damilola', 'Ebuka', 'Emeka', 'Fatima', 'Folake', 'Funmilayo', 'Ifeanyi', 'Ibrahim', 'Kelechi', 'Kemi',
  'Musa', 'Ngozi', 'Nkechi', 'Obinna', 'Olamide', 'Oluwaseun', 'Segun', 'Sadiq', 'Temitope', 'Tunde',
  'Uche', 'Usman', 'Yetunde', 'Zainab', 'Halima', 'Ikenna', 'Tobi', 'Efe', 'Osagie', 'Ese',
];

const LAST_NAMES = [
  'Abubakar', 'Adeyemi', 'Afolabi', 'Akinola', 'Bello', 'Chukwu', 'Danjuma', 'Eze', 'Ibekwe', 'Igwe',
  'Lawal', 'Mohammed', 'Nwachukwu', 'Nwosu', 'Obi', 'Odu', 'Ogunleye', 'Okafor', 'Okeke', 'Okonkwo',
  'Okoro', 'Olawale', 'Onyeka', 'Osagie', 'Oyelaran', 'Salami', 'Suleiman', 'Usman', 'Yakubu', 'Yusuf',
];

const FACULTIES = [
  { code: 'SCI', name: 'Science' },
  { code: 'ENG', name: 'Engineering' },
  { code: 'SSC', name: 'Social Sciences' },
  { code: 'ART', name: 'Arts' },
  { code: 'MGT', name: 'Management Sciences' },
];

const LEVELS = [100, 200, 300, 400, 500];
// Academic session 2025/2026: 100-level students entered in 2025.
const CURRENT_ENTRY_YEAR = 2025;

/** Small seeded PRNG (mulberry32) so output is reproducible. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate `count` student records, e.g.
 * { matric_no: 'SCI/2022/0001', name: 'Chidi Okafor', level: 400, faculty: 'Science' }
 */
function generateStudents(count, seed = 2026) {
  const rand = prng(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const sequence = new Map();
  const students = [];

  for (let i = 0; i < count; i += 1) {
    const faculty = FACULTIES[i % FACULTIES.length];
    const level = LEVELS[Math.floor(i / FACULTIES.length) % LEVELS.length];
    const entryYear = CURRENT_ENTRY_YEAR - (level / 100 - 1);
    const key = `${faculty.code}/${entryYear}`;
    const seq = (sequence.get(key) || 0) + 1;
    sequence.set(key, seq);

    students.push({
      matric_no: `${key}/${String(seq).padStart(4, '0')}`,
      name: `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
      level,
      faculty: faculty.name,
    });
  }
  return students;
}

/** Seeded email for a student record: firstname.lastname.<n>@students.campusgate.test */
function studentEmail(student, index) {
  const [first, last] = student.name.toLowerCase().split(' ');
  return `${first}.${last}.${index + 1}@students.campusgate.test`;
}

module.exports = { generateStudents, studentEmail, FACULTIES, LEVELS };
