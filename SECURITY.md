# Política de segurança

## Versões com suporte

Somente a versão mais recente publicada na
[Chrome Web Store](https://chromewebstore.google.com/detail/audita-acessibilidade/pehaoepmcnngopfknnmlbfdhcimfdccb)
e na [última release](https://github.com/andrebadini/acessibilidade-digital/releases/latest) recebe correções de
segurança.

## Como relatar uma vulnerabilidade

**Não abra uma issue pública.** Use o relato privado do GitHub:
[Security → Report a vulnerability](https://github.com/andrebadini/acessibilidade-digital/security/advisories/new).

Inclua, sempre que possível:

- a versão da extensão e do Chrome;
- os passos para reproduzir, com uma página de teste mínima (sem dados reais de terceiros);
- o impacto esperado (por exemplo, execução de script no relatório exportado, vazamento de conteúdo auditado,
  escalada a partir de uma página auditada).

Você receberá uma confirmação de recebimento e será informado sobre a correção. Pedimos que aguarde a publicação da
versão corrigida antes de divulgar os detalhes.

## Escopo

São especialmente relevantes:

- conteúdo da página auditada que consiga executar código no painel, no relatório aberto ou nos arquivos exportados;
- qualquer envio de dados para fora do dispositivo;
- capturas ou dados retidos além do prazo ou após a exclusão;
- uso indevido das permissões `debugger`, `scripting` ou `tabs`.

A extensão não tem servidor próprio; relatos sobre sites de terceiros auditados estão fora do escopo.
