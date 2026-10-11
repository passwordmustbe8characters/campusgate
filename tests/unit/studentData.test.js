'use strict';

const { generateStudents, studentEmail, LEVELS } = require('../../db/seed/lib/studentData');

describe('seed student generator', () => {
  const students = generateStudents(2000);

  test('produces the requested number of records with unique matric numbers', () => {
    expect(students).toHaveLength(2000);
    expect(new Set(students.map((s) => s.matric_no)).size).toBe(2000);
  });

  test('is deterministic, so demos and load tests are reproducible', () => {
    expect(generateStudents(50)).toEqual(generateStudents(50));
    expect(generateStudents(50)).toEqual(students.slice(0, 50));
  });

  test('matric numbers are normalized and levels are valid', () => {
    for (const s of students) {
      expect(s.matric_no).toMatch(/^[A-Z]{3}\/20\d\d\/\d{4}$/);
      expect(LEVELS).toContain(s.level);
    }
  });

  test('entry year matches level (100L entered in 2025)', () => {
    const first100 = students.find((s) => s.level === 100);
    const first400 = students.find((s) => s.level === 400);
    expect(first100.matric_no).toContain('/2025/');
    expect(first400.matric_no).toContain('/2022/');
  });

  test('seeded emails are unique and use the reserved .test domain', () => {
    const emails = students.map(studentEmail);
    expect(new Set(emails).size).toBe(emails.length);
    expect(emails.every((e) => e.endsWith('@students.campusgate.test') && e === e.toLowerCase())).toBe(true);
  });
});
