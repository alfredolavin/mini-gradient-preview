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

  test('collectClassToGradientMap correctly parses all sequential classes including peach-fuzz', () => {
    const cssText = `
.cherry-blossom {
  --degradado: linear-gradient(180deg, oklch(80% 0.25 350), oklch(45% 0.25 350));
}
.cyber-blue {
  --degradado: linear-gradient(180deg, oklch(85% 0.15 230), oklch(40% 0.25 260));
}
.peach-fuzz {
  --degradado: linear-gradient(180deg, oklch(85% 0.15 60), oklch(45% 0.2 15));
}
    `;

    const mockDoc = {
      getText: () => cssText
    } as any;

    const { varMap, varCountMap } = myExtension.collectCssVariables([mockDoc]);
    const classMap = myExtension.collectClassToGradientMap(varMap, varCountMap, [mockDoc]);

    assert.strictEqual(classMap.has('cherry-blossom'), true);
    assert.strictEqual(classMap.has('cyber-blue'), true);
    assert.strictEqual(classMap.has('peach-fuzz'), true);
    assert.strictEqual(classMap.get('peach-fuzz'), 'linear-gradient(180deg, oklch(85% 0.15 60), oklch(45% 0.2 15))');
  });

  test('collectClassToGradientMap disables preview if comment /*...*/ appears before var in background definition', () => {
    const cssText = `
:root {
  --example: linear-gradient(to right, red, blue);
}
.class-with-comment-before {
  background: /* */ var(--example);
}
.class-without-comment {
  background: var(--example);
}
.class-with-comment-after {
  background: var(--example) /* comment */;
}
    `;

    const mockDoc = {
      getText: () => cssText
    } as any;

    const { varMap, varCountMap } = myExtension.collectCssVariables([mockDoc]);
    const classMap = myExtension.collectClassToGradientMap(varMap, varCountMap, [mockDoc]);

    assert.strictEqual(classMap.has('class-with-comment-before'), false, 'Should disable preview when comment is before var');
    assert.strictEqual(classMap.has('class-without-comment'), true, 'Should enable preview when no comment is present');
    assert.strictEqual(classMap.has('class-with-comment-after'), true, 'Should enable preview when comment is after var');
  });
});

