import { describe, it, expect } from 'vitest';
import { renderEventHtml } from '../src/ui/presentation';
import { HANDOFF_PREFIX, HANDOFF_TAIL } from '../src/core/handoff';

describe('rendu du dossier de passation', () => {
  it('replie le dossier et garde le message visible', () => {
    const text = `${HANDOFF_PREFIX} — tu reprends…\n## Demande d'origine\n<x>\n\n${HANDOFF_TAIL}\n\nQuel fichier ?`;
    const html = renderEventHtml({ type: 'user_text', text }, 'b1');
    expect(html).toContain('<details class="handoff"><summary>Dossier de passation</summary>');
    expect(html).toContain('&#60;x&#62;');
    expect(html).not.toContain('<x>');
    expect(html.endsWith('Quel fichier ?</div></div>')).toBe(true);
  });

  it("n'affecte pas un message ordinaire", () => {
    const html = renderEventHtml({ type: 'user_text', text: 'Bonjour' }, 'b2');
    expect(html).not.toContain('handoff');
  });
});
