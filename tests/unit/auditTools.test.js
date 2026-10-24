'use strict';

const { csvCell, csvRow } = require('../../app/src/audit/csv');
const { parsePolicyChanges } = require('../../app/src/services/adminChangeService');
const { describeFilters } = require('../../app/src/audit/query');
const { buildEvent, AuditEventError } = require('../../app/src/audit/events');

describe('CSV export cells (FR-L4) with formula-injection protection', () => {
  test.each([
    ['=HYPERLINK("http://evil.example","click")', `"'=HYPERLINK(""http://evil.example"",""click"")"`],
    ['+cmd|" /C calc"!A0', `"'+cmd|"" /C calc""!A0"`],
    ['-2+3', "'-2+3"],
    ['@SUM(1+1)', "'@SUM(1+1)"],
    ['\tTAB', "'\tTAB"],
    ['\rCR', `"'\rCR"`],
  ])('neutralizes %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  test('normal values: quoting only when needed, null as empty, objects as JSON, dates as ISO', () => {
    expect(csvCell('login_success')).toBe('login_success');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(false)).toBe('false');
    expect(csvCell({ reason: 'bad_password' })).toBe('"{""reason"":""bad_password""}"');
    expect(csvCell(new Date('2026-10-24T10:00:00Z'))).toBe('2026-10-24T10:00:00.000Z');
    expect(csvRow(['a', 'b'])).toBe('a,b\r\n');
  });
});

describe('policy change parsing (FR-Z5)', () => {
  test('parses whitelisted fields with types', () => {
    expect(parsePolicyChanges(['max_attempts=3', 'require_upper=false'])).toEqual({ max_attempts: 3, require_upper: false });
  });

  test.each([
    [['require_2fa_admin=false'], /cannot be changed/],
    [['nonsense=1'], /unknown policy field/],
    [['max_attempts=three'], /not a whole number/],
    [['require_upper=maybe'], /not true or false/],
    [['max_attempts'], /expected key=value/],
    [[], /no changes given/],
  ])('rejects %j', (pairs, message) => {
    expect(() => parsePolicyChanges(pairs)).toThrow(message);
  });
});

describe('audit details stay safe', () => {
  test('the filters summary recorded for an export never contains the searched user', () => {
    expect(describeFilters({ type: 'login_failure', user: 'someone@example.com', success: false }))
      .toBe('type=login_failure user=given success=false');
  });

  test('an email address cannot be put into an audit event', () => {
    expect(() => buildEvent('audit_exported', { success: true, details: { actor: 'cli', rows: 1, filters: 'x@example.com' } }, {}))
      .toThrow(AuditEventError);
  });
});
