import { describe, it, expect } from 'vitest';
import { isRated, averageRating, rankByRating } from './rating';

/**
 * An employee's rating is the OUTPUT of a completed appraisal. Most people do
 * not have one — the field has no default — and reading it as a number
 * regardless is what killed the Performance page: `e.rating.toFixed(1)` threw
 * on the first unrated employee and the error boundary replaced the whole
 * screen.
 */
describe('isRated', () => {
  it('accepts a real rating, including zero', () => {
    expect(isRated({ rating: 4.5 })).toBe(true);
    expect(isRated({ rating: 0 })).toBe(true);
  });

  it('rejects the absence of one', () => {
    for (const employee of [{}, { rating: null }, { rating: undefined }, { rating: NaN }, { rating: '4' }]) {
      expect(isRated(employee), JSON.stringify(employee)).toBe(false);
    }
  });
});

describe('averageRating', () => {
  it('averages only the people who HAVE a rating', () => {
    // Dividing by everyone would report a lower company average purely
    // because a review is outstanding.
    expect(averageRating([{ rating: 4 }, { rating: 5 }, {}, { rating: null }])).toBe('4.50');
  });

  it('says "no data" rather than zero when nobody has been rated', () => {
    expect(averageRating([{}, { rating: null }])).toBe('—');
    expect(averageRating([])).toBe('—');
  });
});

describe('rankByRating', () => {
  it('puts rated people first, best first', () => {
    const ranked = rankByRating([
      { name: 'Unrated B' },
      { name: 'Good', rating: 4 },
      { name: 'Unrated A' },
      { name: 'Best', rating: 5 },
    ]);
    expect(ranked.map((e) => e.name)).toEqual(['Best', 'Good', 'Unrated A', 'Unrated B']);
  });

  it('does not mutate the array it was given', () => {
    const people = [{ name: 'A', rating: 1 }, { name: 'B', rating: 5 }];
    rankByRating(people);
    expect(people.map((e) => e.name)).toEqual(['A', 'B']);
  });
});
