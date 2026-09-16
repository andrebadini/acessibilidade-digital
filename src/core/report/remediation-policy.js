import { NBR17225_ITEMS } from '../normative/nbr17225.js';

const MAX_TARGETS_PER_RULE = 10_240;
const MAX_TARGET_TEXT = 200;
const ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const TOKEN = /^[A-Za-z0-9._:-]{1,100}$/u;

const ITEM_BY_RULE_ID = new Map(NBR17225_ITEMS.flatMap(item =>
  item.ruleIds.map(ruleId => [ruleId, item])));

const POLICY = new Map();
const EXPLICIT_RULES = new Set();

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function codepointLength(value, maximum) {
  if (typeof value !== 'string' || value.length > maximum * 2) return false;
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > maximum) return false;
  }
  return true;
}

function boundedToken(value) {
  return typeof value === 'string' && codepointLength(value, 100) && TOKEN.test(value);
}

function finiteBetween(minimum, maximum) {
  return value => typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function oneOf(...values) {
  const allowed = new Set(values);
  return value => allowed.has(value);
}

function stringList(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 32 &&
    value.every(boundedToken) && new Set(value).size === value.length;
}

const PARAM = Object.freeze({
  attribute: oneOf(
    'for', 'headers', 'labels', 'aria-activedescendant', 'aria-controls', 'aria-describedby',
    'aria-details', 'aria-errormessage', 'aria-flowto', 'aria-labelledby', 'aria-owns',
  ),
  behavior: oneOf('target-blank', 'observed-new-window'),
  contextObservation: oneOf('potential-context', 'missing-context', 'unknown-context'),
  declaredPurpose: oneOf('content', 'functional', 'decorative', 'complex', 'text', 'image-map', 'unknown'),
  durationSeconds: finiteBetween(0, 1_000_000_000),
  flashesPerSecond: finiteBetween(0, 1_000),
  height: finiteBetween(0, 1_000_000),
  itemId: value => typeof value === 'string' && ID.test(value),
  iterationCount: value => value === null || finiteBetween(0, 1_000_000_000)(value),
  largeText: value => typeof value === 'boolean',
  level: value => Number.isSafeInteger(value) && value >= 1 && value <= 6,
  previousLevel: value => Number.isSafeInteger(value) && value >= 1 && value <= 6,
  ratio: finiteBetween(0, 21),
  role: boundedToken,
  states: stringList,
  threshold: finiteBetween(0, 100),
  totalDurationSeconds: value => value === null || finiteBetween(0, 1_000_000_000)(value),
  width: finiteBetween(0, 1_000_000),
});

const MESSAGE = Object.freeze({
  'missing-page-title': 'Informe um título para a página.',
  'invalid-page-language': 'Declare um idioma principal com uma tag BCP 47 válida.',
  'invalid-part-language': 'Use uma tag BCP 47 válida para esta parte da página.',
  'missing-frame-title': 'Informe um título não vazio para este frame.',
  'invalid-heading-semantics': 'Exponha este cabeçalho com função e nível semânticos válidos.',
  'invalid-heading-level': 'Informe um nível de cabeçalho entre 1 e 6.',
  'heading-level-skip': 'Corrija a progressão dos níveis de cabeçalho.',
  'missing-main-heading': 'Forneça um cabeçalho que identifique o conteúdo principal.',
  'missing-section-heading': 'Forneça um cabeçalho que identifique esta seção.',
  'invalid-landmark-semantics': 'Use uma região semântica válida e compatível com o elemento.',
  'duplicate-unique-landmark': 'Mantenha apenas uma região desta função quando ela deve ser única.',
  'duplicate-or-missing-landmark-name': 'Dê nomes acessíveis distintos às regiões repetidas.',
  'suppressed-listitem-semantics': 'Não suprima a semântica deste item de lista.',
  'invalid-list-role': 'Preserve a semântica de lista deste elemento.',
  'listitem-outside-list': 'Mantenha este item dentro de uma lista semântica.',
  'suppressed-table-cell-semantics': 'Não suprima a semântica desta célula de tabela.',
  'invalid-table-role': 'Preserve a semântica de tabela deste elemento.',
  'cell-outside-table': 'Mantenha esta célula dentro de uma tabela semântica.',
  'invalid-header-reference': 'Corrija a referência de cabeçalho desta célula.',
  'cross-table-header-reference': 'Associe a célula apenas a cabeçalhos da mesma tabela.',
  'missing-link-semantics': 'Exponha esta interação com semântica de link.',
  'missing-button-semantics': 'Exponha esta interação com semântica de botão.',
  'missing-accessible-name': 'Forneça um nome acessível objetivo para este componente.',
  'generic-link-purpose': 'Confirme e torne explícita a finalidade deste link no contexto observado.',
  'new-window-warning-observation-incomplete': 'Complete a observação do aviso acessível de nova janela ou guia.',
  'missing-new-window-warning': 'Avise acessivelmente que este link abre em nova janela ou guia.',
  'visible-label-not-in-name': 'Inclua o rótulo visível no nome acessível do componente.',
  'custom-component-candidate': 'Prefira um elemento nativo quando ele atender à finalidade do componente.',
  'missing-custom-role': 'Informe uma função semântica para este componente customizado.',
  'abstract-role': 'Use uma função ARIA concreta e compatível com a interação.',
  'presentational-interactive-role': 'Não aplique função de apresentação a um componente interativo.',
  'unknown-role': 'Use uma função ARIA registrada e compatível com o componente.',
  'role-interaction-mismatch': 'Alinhe a função ARIA com o comportamento interativo observado.',
  'role-ax-mismatch': 'Alinhe a função declarada com a função calculada na árvore de acessibilidade.',
  'role-interactivity-mismatch': 'Não use função de widget em conteúdo não interativo.',
  'non-widget-interactive-role': 'Use uma função de widget compatível com o componente interativo.',
  'missing-field-label': 'Forneça um rótulo acessível para este campo.',
  'missing-idref': 'Corrija a referência programática que não localiza um alvo único.',
  'ambiguous-idref': 'Use uma referência programática que localize um único alvo.',
  'invalid-label-target': 'Associe este rótulo a um campo rotulável.',
  'invalid-label-reference': 'Corrija a referência de rótulo normalizada deste campo.',
  'missing-label-reference': 'Forneça o rótulo referenciado por este campo.',
  'label-associated-to-other-field': 'Associe o rótulo ao campo correspondente.',
  'missing-association': 'Associe programaticamente um rótulo a este campo.',
  'missing-related-fields-group': 'Agrupe e nomeie programaticamente estes campos relacionados.',
  'invalid-required-state': 'Use um valor válido para o estado obrigatório.',
  'required-state-mismatch': 'Mantenha o estado obrigatório programático consistente.',
  'missing-required-identification': 'Ofereça uma marcação de obrigatoriedade que todos possam perceber, ou confirme que o campo já a identifica por outro meio.',
  'invalid-or-missing-autocomplete': 'Use autocomplete válido e compatível com a finalidade deste campo.',
  'missing-status-role': 'Exponha esta mensagem com uma função de status adequada.',
  'focus-indicator-not-visible': 'Forneça um indicador de foco visível.',
  'focus-not-fully-visible': 'Evite que outros conteúdos ocultem o elemento focado.',
  'focus-not-partially-visible': 'Mantenha ao menos parte do elemento focado visível.',
  'focus-indicator-area-insufficient': 'Aumente a área observável do indicador de foco.',
  'orientation-restricted': 'Permita o uso em ambas as orientações.',
  'two-dimensional-scroll': 'Faça o conteúdo refluir sem rolagem em duas dimensões.',
  'text-spacing-content-loss': 'Corrija a perda ou sobreposição causada pelos espaçamentos de teste.',
  'justified-text-block': 'Evite justificar este bloco de texto.',
  'text-block-too-wide': 'Limite a largura deste bloco a 80 caracteres por linha.',
  'missing-special-text-semantics': 'Exponha programaticamente o significado deste texto especial.',
  'zoom-restricted': 'Remova a restrição de ampliação da página.',
  'decorative-alternative-not-empty': 'Remova a alternativa textual de uma imagem confirmada como decorativa.',
  'missing-decorative-empty-alternative': 'Forneça alternativa vazia para a imagem confirmada como decorativa.',
  'missing-alternative': 'Forneça uma alternativa textual não vazia para esta imagem.',
  'unknown-image-purpose': 'Determine a finalidade da imagem antes de concluir a alternativa adequada.',
  'verify-alternative-quality': 'Compare a alternativa textual com a finalidade e o conteúdo da imagem.',
  'missing-autoplay-audio-control': 'Forneça pausa, parada ou volume independente para este áudio automático.',
  'unknown-video-audio': 'Determine se este vídeo possui áudio antes de concluir a exigência de legendas.',
  'unknown-media-timing': 'Confirme se esta mídia é gravada ou transmitida ao vivo antes de escolher a verificação aplicável.',
  'captions-not-determined': 'Sem faixa de legendas identificada: procure legendas na imagem ou no player. Confira se o vídeo é uma alternativa identificada para texto equivalente.',
  'unknown-media-essentiality': 'Determine a finalidade da mídia antes de concluir a exigência de legendas.',
  'missing-captions-observation': 'Colete as faixas de texto deste vídeo antes de concluir a presença de legendas.',
  'missing-captions-track': 'Forneça uma faixa de legendas para este vídeo pré-gravado com áudio.',
  'verify-caption-equivalence': 'Compare as legendas com todo o conteúdo sonoro relevante.',
  'malformed-captions-track': 'Complete os metadados da faixa antes de verificar as legendas.',
  'missing-animation-control': 'Forneça controle para pausar, parar ou ocultar esta animação.',
  'reduced-motion-not-respected': 'Permita desabilitar esta animação de interação por preferência de movimento reduzido.',
  'reduced-motion-mechanism-observed': 'Confirme se o mecanismo de movimento reduzido é suficiente e se a animação é essencial.',
  'verify-interaction-animation': 'Confirme se esta animação pode ser desabilitada e se é essencial.',
  'flash-rate-exceeded': 'Reduza a frequência para no máximo três flashes por segundo.',
  'general-flash-threshold-exceeded': 'Reduza frequência, intensidade ou área do conteúdo intermitente.',
  'missing-updating-content-control': 'Forneça controle para pausar, parar ou ocultar esta atualização.',
  'table-title-not-associated': 'Associe programaticamente o título a esta tabela.',
  'missing-submit-button': 'Forneça um botão explícito para submeter este formulário.',
  'missing-custom-component-state': 'Exponha os estados, propriedades e valores necessários deste componente.',
});

function register(ruleIds, reason, parameters = [], message = MESSAGE[reason], refine = null) {
  for (const ruleId of ruleIds) {
    const key = `${ruleId}\u0000${reason}`;
    if (POLICY.has(key) || typeof message !== 'string') throw new TypeError('Catálogo de remediação core inválido.');
    POLICY.set(key, Object.freeze({ parameters: Object.freeze([...parameters]), message, refine }));
    EXPLICIT_RULES.add(ruleId);
  }
}

register(['page-title'], 'missing-page-title');
register(['page-language'], 'invalid-page-language');
register(['part-language'], 'invalid-part-language');
register(['frame-title'], 'missing-frame-title');
register(['heading-semantics'], 'invalid-heading-semantics');
register(['heading-semantics'], 'invalid-heading-level');
register(['heading-order'], 'heading-level-skip', ['previousLevel', 'level']);
register(['main-heading'], 'missing-main-heading');
register(['section-headings'], 'missing-section-heading');
register(['landmark-semantics'], 'invalid-landmark-semantics');
register(['unique-landmarks'], 'duplicate-unique-landmark', ['role']);
register(['landmark-unique-names'], 'duplicate-or-missing-landmark-name', ['role']);
register(['list-semantics'], 'suppressed-listitem-semantics');
register(['list-semantics'], 'invalid-list-role');
register(['list-semantics'], 'listitem-outside-list');
register(['table-semantics'], 'suppressed-table-cell-semantics');
register(['table-semantics'], 'invalid-table-role');
register(['table-semantics'], 'cell-outside-table');
register(['table-headers'], 'invalid-header-reference', ['attribute'], undefined,
  data => data.attribute === 'headers');
register(['table-headers'], 'cross-table-header-reference', ['attribute'], undefined,
  data => data.attribute === 'headers');

const LINK_PURPOSE_RULES = ['link-purpose-as-link', 'link-purpose-without-context', 'link-purpose-in-context'];
const BUTTON_PURPOSE_RULES = ['button-purpose-as-button', 'button-purpose'];
register(['link-semantics', ...LINK_PURPOSE_RULES], 'missing-link-semantics');
register(['button-semantics', ...BUTTON_PURPOSE_RULES], 'missing-button-semantics');
register([...LINK_PURPOSE_RULES, ...BUTTON_PURPOSE_RULES, 'accessible-component-name'], 'missing-accessible-name');
register(LINK_PURPOSE_RULES, 'generic-link-purpose', ['contextObservation']);
register(['new-window-link-warning'], 'new-window-warning-observation-incomplete', ['behavior']);
register(['new-window-link-warning'], 'missing-new-window-warning', ['behavior']);
register(['visible-label-in-name'], 'visible-label-not-in-name');
register(['native-elements'], 'custom-component-candidate');
register(['custom-component-semantics'], 'missing-custom-role');
for (const reason of [
  'abstract-role', 'presentational-interactive-role', 'unknown-role', 'role-interaction-mismatch',
  'role-ax-mismatch', 'role-interactivity-mismatch', 'non-widget-interactive-role',
]) register(['custom-component-semantics'], reason);
for (const reason of ['missing-idref', 'ambiguous-idref']) {
  register(['accessible-component-name', 'custom-component-semantics'], reason, ['attribute'], undefined,
    data => data.attribute.startsWith('aria-'));
}

register(['form-field-label'], 'missing-field-label');
register(['form-label-association'], 'missing-idref', ['attribute'], undefined, data => data.attribute === 'for');
register(['form-label-association'], 'ambiguous-idref', ['attribute'], undefined, data => data.attribute === 'for');
register(['form-label-association'], 'invalid-label-target', ['attribute'], undefined, data => data.attribute === 'for');
for (const reason of ['invalid-label-reference', 'missing-label-reference', 'label-associated-to-other-field']) {
  register(['form-label-association'], reason, ['attribute'], undefined, data => data.attribute === 'labels');
}
register(['form-label-association'], 'missing-association');
register(['related-fields-grouping'], 'missing-related-fields-group');
register(['required-field-identification'], 'invalid-required-state');
register(['required-field-identification'], 'required-state-mismatch');
register(['required-field-identification'], 'missing-required-identification');
register(['input-purpose'], 'invalid-or-missing-autocomplete');
register(['status-message-semantics'], 'missing-status-role');

register(['focus-visible'], 'focus-indicator-not-visible');
register(['focus-fully-visible'], 'focus-not-fully-visible');
register(['focus-partially-visible'], 'focus-not-partially-visible');
register(['focus-indicator-area'], 'focus-indicator-area-insufficient');
register(['target-size-enhanced'], 'target-too-small', ['width', 'height', 'threshold'],
  'Aumente a área de acionamento para pelo menos 44 por 44 CSS px.', data => data.threshold === 44);
register(['target-size-minimum'], 'target-too-small', ['width', 'height', 'threshold'],
  'Aumente a área de acionamento para pelo menos 24 por 24 CSS px.', data => data.threshold === 24);
register(['display-orientation'], 'orientation-restricted');
register(['responsive-reflow'], 'two-dimensional-scroll');
register(['text-contrast-enhanced'], 'insufficient-text-contrast', ['ratio', 'threshold', 'largeText'],
  'Aumente o contraste do texto até o limite aplicável.', data => data.threshold === (data.largeText ? 4.5 : 7));
register(['text-contrast-minimum'], 'insufficient-text-contrast', ['ratio', 'threshold', 'largeText'],
  'Aumente o contraste do texto até o limite aplicável.', data => data.threshold === (data.largeText ? 3 : 4.5));
for (const ruleId of ['component-contrast', 'graphic-object-contrast', 'focus-indicator-contrast']) {
  register([ruleId], 'insufficient-non-text-contrast', ['ratio', 'threshold'],
    'Aumente o contraste não textual para pelo menos 3:1.', data => data.threshold === 3);
}
register(['component-contrast'], 'inactive-component-unconfirmed', [],
  'O componente declara estar inativo. Confirme se realmente não pode ser acionado; apenas a declaração não comprova a exceção de contraste.');
for (const ruleId of ['line-spacing', 'paragraph-spacing', 'letter-spacing', 'word-spacing']) {
  register([ruleId], 'text-spacing-content-loss');
}
register(['text-block-alignment'], 'justified-text-block');
register(['text-block-alignment'], 'alignment-essentiality-unconfirmed', [],
  'O alinhamento difere do recomendado para o idioma declarado. Confirme se ele é essencial para compreender o conteúdo; caso contrário, alinhe ao início da leitura.');
register(['text-block-width'], 'text-block-too-wide');
register(['text-block-width'], 'text-width-configuration-unconfirmed', ['width', 'threshold'],
  'A linha observada excede o limite de referência. Verifique se existe um mecanismo para ajustar a largura até 80 caracteres por linha, ou 40 para chinês, japonês e coreano.',
  data => Number.isSafeInteger(data.width) && [40, 80].includes(data.threshold) && data.width > data.threshold);
register(['special-text-semantics'], 'missing-special-text-semantics');
register(['zoom-not-blocked'], 'zoom-restricted');

const IMAGE_RULES = [
  'content-image-alternative', 'functional-image-alternative', 'decorative-image-alternative',
  'complex-image-description', 'images-of-text', 'image-map-alternative',
];
register(['decorative-image-alternative'], 'decorative-alternative-not-empty');
register(['decorative-image-alternative'], 'missing-decorative-empty-alternative');
register(IMAGE_RULES.filter(ruleId => !['decorative-image-alternative', 'images-of-text'].includes(ruleId)), 'missing-alternative');
register(IMAGE_RULES, 'unknown-image-purpose', ['declaredPurpose']);
register(IMAGE_RULES, 'verify-alternative-quality', ['declaredPurpose']);
register(['audio-control'], 'missing-autoplay-audio-control', ['durationSeconds']);
for (const reason of [
  'unknown-video-audio', 'unknown-media-timing', 'unknown-media-essentiality', 'missing-captions-observation',
  'missing-captions-track', 'captions-not-determined', 'verify-caption-equivalence', 'malformed-captions-track',
]) register(['video-captions'], reason);
const MEDIA_REVIEW_MESSAGES = Object.freeze({
  'audio-text-alternative': 'Compare a alternativa textual com todo o áudio pré-gravado.',
  'video-transcript': 'Compare a transcrição com as informações visuais e sonoras do vídeo.',
  'video-audio-description': 'Verifique se a audiodescrição comunica as informações visuais necessárias.',
  'extended-audio-description': 'Verifique se pausas e audiodescrição estendida cobrem todas as informações visuais.',
  'sign-language-interpretation': 'Verifique a equivalência e legibilidade da interpretação em Libras.',
  'low-background-audio': 'Meça ou compare o áudio de fundo com a fala principal.',
  'live-captions': 'Observe a transmissão e confirme legendas ao vivo equivalentes.',
  'live-audio-transcript': 'Observe a transmissão e confirme uma alternativa textual ao vivo equivalente.',
});
for (const [ruleId, message] of Object.entries(MEDIA_REVIEW_MESSAGES)) {
  register([ruleId], 'verify-media-equivalence', [], message);
  register([ruleId], 'unknown-media-timing');
}
register(['animation-control'], 'missing-animation-control',
  ['durationSeconds', 'iterationCount', 'totalDurationSeconds']);
register(['interaction-animation'], 'reduced-motion-not-respected');
register(['interaction-animation'], 'reduced-motion-mechanism-observed');
register(['interaction-animation'], 'verify-interaction-animation');
register(['flashing-content-enhanced'], 'flash-rate-exceeded', ['flashesPerSecond']);
register(['flashing-content-limit'], 'general-flash-threshold-exceeded');
register(['updating-content-control'], 'missing-updating-content-control');

register(['table-title-association'], 'table-title-not-associated');
register(['form-submit-button'], 'missing-submit-button');
register(['custom-component-state'], 'missing-custom-component-state', ['states']);

const HUMAN_TARGET_RULES = new Set([
  'focus-order', 'focusable-elements-interactive', 'keyboard-focus-trap', 'full-keyboard-access',
  'partial-keyboard-access', 'single-key-shortcuts', 'single-key-shortcut-control',
  'concurrent-input-mechanisms', 'hover-focus-additional-content', 'hover-focus-content-persistent',
  'hover-focus-content-dismissible', 'custom-component-behavior', 'custom-component-instructions',
  'consistent-component-identification-page', 'predictable-context-change', 'context-change-on-focus',
  'context-change-on-input', 'single-pointer-cancellation', 'pointer-gesture-alternative',
  'dragging-movement-alternative', 'motion-actuation-alternative', 'control-feedback', 'heading-purpose',
  'landmark-purpose', 'content-in-landmarks', 'list-purpose', 'table-purpose', 'table-title',
  'complex-table-description', 'file-link-identification', 'external-link-identification',
  'complementary-link-text', 'adjacent-links', 'bypass-block-links', 'predictable-field-label',
  'descriptive-field-label', 'predictable-help-text', 'descriptive-error-message',
  'error-correction-suggestion', 'contextual-help', 'sensory-motion-validation',
]);
const PAGE_INSUFFICIENT_RULES = new Set([
  'hover-focus-additional-content', 'hover-focus-content-persistent', 'hover-focus-content-dismissible',
  'single-key-shortcuts', 'single-key-shortcut-control', 'full-keyboard-access',
  'partial-keyboard-access', 'concurrent-input-mechanisms',
]);

function humanPolicy(ruleId, reason, data) {
  const item = ITEM_BY_RULE_ID.get(ruleId);
  if (!item || EXPLICIT_RULES.has(ruleId) || data.itemId !== item.id) return null;
  if (reason === 'human-judgment-required' && HUMAN_TARGET_RULES.has(ruleId)) {
    return `Revise manualmente: ${item.title}.`;
  }
  if (reason === 'page-level-insufficient-observation' && PAGE_INSUFFICIENT_RULES.has(ruleId)) {
    return `Revise a página e suas interações quanto a: ${item.title}.`;
  }
  if (reason === 'page-level-human-judgment') {
    return `Revise a página e o processo quanto a: ${item.title}.`;
  }
  return null;
}

function canonicalPolicy(ruleId, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.reason !== 'string') return null;
  const direct = POLICY.get(`${ruleId}\u0000${data.reason}`);
  if (direct) {
    if (!exactKeys(data, ['reason', ...direct.parameters])) return null;
    for (const parameter of direct.parameters) {
      if (!PARAM[parameter]?.(data[parameter])) return null;
    }
    if (direct.refine && direct.refine(data) !== true) return null;
    return direct;
  }
  if (!['human-judgment-required', 'page-level-insufficient-observation', 'page-level-human-judgment'].includes(data.reason) ||
    !exactKeys(data, ['reason', 'itemId']) || !PARAM.itemId(data.itemId)) return null;
  const message = humanPolicy(ruleId, data.reason, data);
  return message ? { parameters: Object.freeze(['itemId']), message } : null;
}

export function canonicalCoreRemediation(ruleId, data) {
  const policy = canonicalPolicy(ruleId, data);
  return policy?.message ?? null;
}

export function validateCoreRuleTargetInventory(ruleId, outcome, targets) {
  if (!Array.isArray(targets) || targets.length > MAX_TARGETS_PER_RULE) return false;
  if (!['failed', 'cantTell'].includes(outcome)) return targets.length === 0;
  if (outcome === 'failed' && targets.length === 0) return false;
  for (const target of targets) {
    if (target === null) continue;
    if (typeof target === 'string') {
      if (!ID.test(target)) return false;
      continue;
    }
    if (Number.isSafeInteger(target)) continue;
    if (!target || typeof target !== 'object' || Array.isArray(target)) return false;
    const nodeId = target.nodeId;
    if (!((typeof nodeId === 'string' && ID.test(nodeId)) || Number.isSafeInteger(nodeId))) return false;
    if (exactKeys(target, ['nodeId'])) continue;
    if (!exactKeys(target, ['nodeId', 'data', 'message'])) return false;
    if (target.data?.reason === 'inactive-component-unconfirmed' && outcome !== 'cantTell') return false;
    if (target.data?.reason === 'alignment-essentiality-unconfirmed' && outcome !== 'cantTell') return false;
    if (target.data?.reason === 'text-width-configuration-unconfirmed' && outcome !== 'cantTell') return false;
    const message = canonicalCoreRemediation(ruleId, target.data);
    if (!message || target.message !== message || !codepointLength(target.message, MAX_TARGET_TEXT)) return false;
  }
  return true;
}
