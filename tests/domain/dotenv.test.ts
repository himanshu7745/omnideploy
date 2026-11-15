import { describe, expect, it } from 'vitest';
import { formatDotenvLine, parseDotenv, pointsToLocalhost, requiredPlaceholders } from '../../src/domain/index.js';

describe('parseDotenv', () => {
  it('handles the usual dotenv syntax', () => {
    const text = [
      '# comment',
      'PLAIN=value',
      'export EXPORTED=yes',
      'SPACED = padded  ',
      'INLINE=abc # trailing comment',
      'HASH_IN_VALUE=abc#def',
      'DOUBLE="with spaces # not a comment"',
      "SINGLE='raw \\n stays'",
      'ESCAPED="line1\\nline2"',
      'EMPTY=',
      'URL=postgres://u:p@db.example.com:5432/app?ssl=true',
      'MULTI="-----BEGIN KEY-----',
      'abc',
      '-----END KEY-----"',
      'not a variable line',
    ].join('\n');
    expect(parseDotenv(text)).toEqual({
      PLAIN: 'value',
      EXPORTED: 'yes',
      SPACED: 'padded',
      INLINE: 'abc',
      HASH_IN_VALUE: 'abc#def',
      DOUBLE: 'with spaces # not a comment',
      SINGLE: 'raw \\n stays',
      ESCAPED: 'line1\nline2',
      EMPTY: '',
      URL: 'postgres://u:p@db.example.com:5432/app?ssl=true',
      MULTI: '-----BEGIN KEY-----\nabc\n-----END KEY-----',
    });
  });

  it('round-trips through formatDotenvLine', () => {
    for (const value of ['simple', 'has space', 'quote " inside', 'multi\nline', '', 'postgres://u:p@h/db']) {
      expect(parseDotenv(formatDotenvLine('K', value)).K).toBe(value);
    }
  });
});

describe('requiredPlaceholders (Spring Boot, Quarkus, Micronaut)', () => {
  it('only counts UPPER_CASE placeholders without a default', () => {
    const yml = ['password: ${DB_PASSWORD}', 'username: ${DB_USER:app}', 'url: jdbc:postgresql://${DB_HOST}:5432/app', 'port: ${server.port}', 'empty-default: ${OPTIONAL_THING:}'].join('\n');
    expect(requiredPlaceholders(yml).sort()).toEqual(['DB_HOST', 'DB_PASSWORD']);
  });
});

describe('pointsToLocalhost', () => {
  it.each([
    ['postgres://u:p@localhost:5432/db', true],
    ['http://127.0.0.1:8080', true],
    ['redis://0.0.0.0:6379', true],
    ['localhost', true],
    ['postgres://u:p@db.example.com/db', false],
    ['https://mylocalhost.dev', false],
  ])('%s → %s', (v, expected) => expect(pointsToLocalhost(v)).toBe(expected));
});
