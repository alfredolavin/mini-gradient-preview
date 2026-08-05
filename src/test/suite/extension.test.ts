import * as assert from 'assert';
import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {

  test('resolveVariableString resolves simple and nested CSS variables', () => {
    const varMap = new Map<string, string>([
      ['--color-start', '#ff0000'],
      ['--color-end', '#0000ff'],
      ['--nested', 'var(--color-start)']
    ]);

    const input = 'linear-gradient(to right, var(--nested), var(--color-end), var(--missing, #00ff00))';
    const resolved = myExtension.resolveVariableString(input, varMap);

    assert.strictEqual(resolved, 'linear-gradient(to right, #ff0000, #0000ff, #00ff00)');
  });

  test('extractGradientAt correctly balances nested parentheses', () => {
    const text = 'background: linear-gradient(135deg, var(--c1, rgba(0,0,0,0.5)), red); color: white;';
    const startOffset = text.indexOf('linear-gradient');
    const result = myExtension.extractGradientAt(text, startOffset);

    assert.notStrictEqual(result, null);
    assert.strictEqual(result?.fullGradient, 'linear-gradient(135deg, var(--c1, rgba(0,0,0,0.5)), red)');
  });
});
