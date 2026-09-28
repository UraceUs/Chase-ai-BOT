// Regras de entrada no Kommo e de operacao do robo chat (SDR).
const { avaliarInteracao, validarEvento, descreverRegras, regras } = require('../../lib/sdr');
const { frasseProibida, dentroDoHorarioComercial } = require('../../lib/sdr/robochat');

// Quarta-feira, 10h em Orlando (America/New_York) => dentro do horario.
const HORARIO_COMERCIAL = new Date('2026-09-23T14:00:00Z');
// Segunda-feira, 10h em Orlando => fora (a operacao e de quarta a domingo).
const FORA_DO_HORARIO = new Date('2026-09-21T14:00:00Z');

function avaliar(payload, agora = HORARIO_COMERCIAL) {
  return avaliarInteracao(payload, { agora });
}

describe('Entrada no Kommo — o que NAO vira card', () => {
  it('saudacao isolada fica so na conversa', () => {
    const { kommo } = avaliar({ canal: 'whatsapp', texto: 'Oi, bom dia!' });

    expect(kommo.criarCard).toBe(false);
    expect(kommo.acao).toBe('somente_conversa');
    expect(kommo.motivo).toBe('SAUDACAO_ISOLADA');
  });

  it('agradecimento e encerramento nao viram card', () => {
    const { kommo } = avaliar({ canal: 'instagram', texto: 'Obrigado!' });

    expect(kommo.criarCard).toBe(false);
    expect(kommo.motivo).toBe('AGRADECIMENTO_OU_ENCERRAMENTO');
  });

  it('spam e prospeccao de fornecedor nao viram card', () => {
    const { kommo, robo } = avaliar({
      canal: 'instagram',
      texto: 'Ola! Trabalho com trafego pago e posso trazer mais seguidores para voces.'
    });

    expect(kommo.criarCard).toBe(false);
    expect(kommo.motivo).toBe('SPAM_OU_OFERTA');
    expect(kommo.tags).toContain('sdr:spam');
    expect(robo.responder).toBe(false);
  });

  it('grupo e lista de transmissao sao ignorados por completo', () => {
    const { kommo, robo } = avaliar({
      canal: 'whatsapp',
      texto: 'Quanto custa o coaching?',
      conversa: { ehGrupo: true }
    });

    expect(kommo.acao).toBe('ignorar');
    expect(robo.responder).toBe(false);
  });

  it('contato interno de teste e ignorado', () => {
    const { kommo, robo } = avaliar({ canal: 'whatsapp', texto: 'teste de integracao', interno: true });

    expect(kommo.acao).toBe('ignorar');
    expect(kommo.motivo).toBe('CONTATO_INTERNO');
    expect(robo.responder).toBe(false);
  });

  it('midia sem texto aguarda contexto antes de abrir card', () => {
    const { kommo, robo } = avaliar({ canal: 'telegram', midia: 'audio' });

    expect(kommo.criarCard).toBe(false);
    expect(kommo.motivo).toBe('MIDIA_SEM_CONTEXTO');
    expect(robo.responder).toBe(true);
  });

  it('pergunta generica sozinha nao atinge o limiar', () => {
    const { kommo } = avaliar({ canal: 'whatsapp', texto: 'Onde fica a pista?' });

    expect(kommo.criarCard).toBe(false);
    expect(kommo.motivo).toBe('SEM_SINAL_COMERCIAL');
  });

  it('contato com card aberto nunca duplica card', () => {
    const { kommo } = avaliar({
      canal: 'whatsapp',
      texto: 'Quanto custa o Summer Camp?',
      card: { existe: true, id: '123', status: 'aberto', estagio: 'Em qualificacao (bot)' }
    });

    expect(kommo.criarCard).toBe(false);
    expect(kommo.acao).toBe('anexar_card');
    expect(kommo.atualizaCard).toBe(true);
  });
});

describe('Entrada no Kommo — o que VIRA card', () => {
  it('pergunta de preco abre card', () => {
    const { kommo } = avaliar({ canal: 'whatsapp', texto: 'Quanto custa o Professional Coaching?' });

    expect(kommo.criarCard).toBe(true);
    expect(kommo.motivo).toBe('INTENCAO_COMERCIAL');
    expect(kommo.estagioSugerido).toBe('Em qualificacao (bot)');
  });

  it('pergunta de disponibilidade abre card', () => {
    const { kommo } = avaliar({ canal: 'messenger', texto: 'Tem vaga no sabado de manha?' });

    expect(kommo.criarCard).toBe(true);
    expect(kommo.motivo).toBe('INTENCAO_COMERCIAL');
  });

  it('sinais fracos somados atingem o limiar', () => {
    const { kommo, analise } = avaliar({ canal: 'whatsapp', texto: 'Queria uma aula no dia 12/10 para 2 pilotos' });

    expect(analise.score).toBeGreaterThanOrEqual(40);
    expect(kommo.criarCard).toBe(true);
  });

  it('reserva da Etapa 1 sempre vira card com o Pit ID', () => {
    const { kommo } = avaliar({
      canal: 'site',
      tipo: 'reserva_etapa1',
      reserva: { pitId: 'PIT-S40K-RTK3VQ', etapa: 1 },
      qualificacao: { servico: 'Summer Camp', data: '12/10/2026', periodo: 'manha' }
    });

    expect(kommo.criarCard).toBe(true);
    expect(kommo.motivo).toBe('RESERVA_ETAPA1');
    expect(kommo.estagioSugerido).toBe('Reserva Etapa 1 (Pit ID gerado)');
    expect(kommo.campos.pit_id).toBe('PIT-S40K-RTK3VQ');
  });

  it('Etapa 2 concluida atualiza o card existente para confirmada', () => {
    const { kommo } = avaliar({
      canal: 'site',
      tipo: 'reserva_etapa2',
      reserva: { pitId: 'PIT-S40K-RTK3VQ', etapa: 2 },
      card: { existe: true, id: '9', status: 'aberto' }
    });

    expect(kommo.acao).toBe('anexar_card');
    expect(kommo.estagioSugerido).toBe('Reserva confirmada');
  });

  it('pedido de atendimento humano abre card direto no estagio humano', () => {
    const { kommo } = avaliar({ canal: 'whatsapp', texto: 'Quero falar com alguem, por favor' });

    expect(kommo.criarCard).toBe(true);
    expect(kommo.motivo).toBe('PEDIDO_HUMANO');
    expect(kommo.estagioSugerido).toBe('Qualificado - humano');
  });

  it('demanda corporativa abre card no estagio humano', () => {
    const { kommo } = avaliar({ canal: 'whatsapp', texto: 'Queria um evento para minha empresa com 12 pilotos' });

    expect(kommo.criarCard).toBe(true);
    expect(kommo.motivo).toBe('DEMANDA_CORPORATIVA');
  });

  it('card fechado ha menos de 30 dias e reaberto em vez de duplicado', () => {
    const { kommo } = avaliar({
      canal: 'whatsapp',
      texto: 'Quero agendar de novo',
      card: { existe: true, id: '7', status: 'ganho', fechadoEm: '2026-09-10T12:00:00Z' }
    });

    expect(kommo.acao).toBe('reabrir_card');
    expect(kommo.criarCard).toBe(false);
    expect(kommo.tags).toContain('sdr:reaberto');
  });

  it('card fechado ha mais de 30 dias gera card novo', () => {
    const { kommo } = avaliar({
      canal: 'whatsapp',
      texto: 'Quero agendar de novo',
      card: { existe: true, id: '7', status: 'ganho', fechadoEm: '2026-01-10T12:00:00Z' }
    });

    expect(kommo.acao).toBe('criar_card');
  });
});

describe('Robo chat — quando responde e quando cala', () => {
  it('nao responde quando um humano assumiu a conversa', () => {
    const { robo } = avaliar({
      canal: 'whatsapp',
      texto: 'Quanto custa?',
      card: { existe: true, id: '3', status: 'aberto', responsavelHumano: 'Marina' }
    });

    expect(robo.responder).toBe(false);
    expect(robo.motivo).toBe('HUMANO_NO_ATENDIMENTO');
  });

  it('avisa o responsavel humano quando o lead fica insatisfeito', () => {
    const { robo } = avaliar({
      canal: 'whatsapp',
      texto: 'Ninguem responde, isso e um descaso',
      card: { existe: true, id: '3', status: 'aberto', responsavelHumano: 'Marina' }
    });

    expect(robo.responder).toBe(false);
    expect(robo.escalonamento.motivo).toBe('LEAD_INSATISFEITO');
    expect(robo.escalonamento.prioridade).toBe('alta');
  });

  it('respeita o bot silenciado manualmente', () => {
    const { robo } = avaliar({
      canal: 'whatsapp',
      texto: 'Quanto custa?',
      card: { existe: true, id: '3', status: 'aberto', botSilenciado: true }
    });

    expect(robo.responder).toBe(false);
    expect(robo.motivo).toBe('BOT_SILENCIADO');
  });

  it('confirma o opt-out uma unica vez e silencia', () => {
    const { robo, kommo } = avaliar({ canal: 'whatsapp', texto: 'Nao quero mais receber mensagens' });

    expect(robo.responder).toBe(true);
    expect(robo.silenciarBot).toBe(true);
    expect(kommo.criarCard).toBe(false);
    expect(kommo.motivo).toBe('OPT_OUT');
  });

  it('nao responde em canal sem robo, mas cria tarefa humana', () => {
    const { robo } = avaliar({ canal: 'telefone', tipo: 'chamada_perdida' });

    expect(robo.responder).toBe(false);
    expect(robo.motivo).toBe('CANAL_SEM_ROBO');
    expect(robo.escalonamento).not.toBeNull();
  });

  it('faz uma pergunta de qualificacao por vez, comecando pela experiencia', () => {
    const { robo } = avaliar({ canal: 'telegram', texto: 'Quanto custa o Summer Camp?' });

    expect(robo.responder).toBe(true);
    expect(robo.proximaPergunta).toMatch(/Qual opcao descreve melhor o piloto/);
    expect(robo.mensagens).toHaveLength(2);
    expect(robo.followUp.agendar).toBe(true);
    expect(robo.followUp.emMinutos).toBe(120);
  });

  it('nao fala de valor antes de classificar a experiencia do piloto', () => {
    const { robo } = avaliar({ canal: 'telegram', texto: 'Quanto custa?' });

    expect(robo.motivo).toBe('PRECO_ANTES_DA_CLASSIFICACAO');
    expect(robo.mensagens.join(' ')).toMatch(/nivel do piloto/);
  });

  it('nao promete preco fechado depois de classificar', () => {
    const { robo } = avaliar({
      canal: 'telegram',
      texto: 'Quanto custa?',
      qualificacao: { experiencia: 'B' }
    });

    expect(robo.mensagens.join(' ')).toMatch(/confirmar a condicao exata com o time/);
  });

  it('encerra a cadencia de follow-up apos 4 tentativas', () => {
    const { robo } = avaliar({
      canal: 'telegram',
      texto: 'Quanto custa o coaching?',
      conversa: { tentativasFollowUp: 4 }
    });

    expect(robo.followUp.agendar).toBe(false);
    expect(robo.followUp.acaoFinal).toBe('marcar_perdido_sem_resposta');
  });

  it('respeita o limite de caracteres por mensagem', () => {
    const { robo } = avaliar({ canal: 'whatsapp', texto: 'Tem data livre?' });

    robo.mensagens.forEach(mensagem => {
      expect(mensagem.length).toBeLessThanOrEqual(350);
    });
  });
});

describe('Robo chat — escalonamento para humano', () => {
  it('escala imediatamente temas sensiveis sem tentar responder o merito', () => {
    const { robo } = avaliar({ canal: 'telegram', texto: 'Meu filho se machucou na pista, quero falar com o advogado' });

    expect(robo.escalonamento.motivo).toBe('TEMA_SENSIVEL');
    expect(robo.escalonamento.prioridade).toBe('alta');
    expect(robo.silenciarBot).toBe(true);
    expect(robo.escalonamento.tarefa.prazoMinutos).toBe(5);
  });

  it('escala pedido de desconto (negociacao e humana)', () => {
    const { robo } = avaliar({ canal: 'telegram', texto: 'Tem desconto para duas pessoas?' });

    expect(robo.escalonamento.motivo).toBe('NEGOCIACAO');
  });

  it('escala quando a qualificacao esta completa', () => {
    const { robo } = avaliar({
      canal: 'telegram',
      texto: 'Isso mesmo',
      qualificacao: {
        servico: 'Professional Coaching',
        data: '12/10/2026',
        periodo: 'manha',
        pilotos: 2,
        experiencia: 'B',
        origem: 'local',
        nome: 'Ana Souza',
        contato: 'ana@exemplo.com'
      }
    });

    expect(robo.escalonamento.motivo).toBe('LEAD_QUALIFICADO');
    expect(robo.escalonamento.resumo.servico).toBe('Professional Coaching');
    expect(robo.escalonamento.resumo.pilotos).toBe(2);
    expect(robo.silenciarBot).toBe(true);
  });

  it('escala apos o limite de tentativas sem entendimento', () => {
    const { robo } = avaliar({
      canal: 'telegram',
      texto: 'xyzw abcd',
      conversa: { tentativasSemEntendimento: 2 }
    });

    expect(robo.escalonamento.motivo).toBe('SEM_ENTENDIMENTO');
  });

  it('pede esclarecimento antes de escalar na primeira tentativa', () => {
    const { robo } = avaliar({ canal: 'telegram', texto: 'xyzw abcd' });

    expect(robo.escalonamento).toBeNull();
    expect(robo.motivo).toBe('SEM_ENTENDIMENTO_TENTATIVA');
  });

  it('escala falha tecnica quando o Pit ID nao existe', () => {
    const { robo } = avaliar({
      canal: 'telegram',
      texto: 'Meu codigo e PIT-S40K-RTK3VQ e nao abre',
      reserva: { pitId: 'PIT-S40K-RTK3VQ', encontrada: false }
    });

    expect(robo.escalonamento.motivo).toBe('FALHA_TECNICA');
  });

  it('cobra a Etapa 2 quando a reserva fica parada', () => {
    const { robo, kommo } = avaliar({
      canal: 'telegram',
      tipo: 'reserva_etapa1_parada',
      reserva: { pitId: 'PIT-S40K-RTK3VQ', etapa: 1 },
      card: { existe: true, id: '5', status: 'aberto' }
    });

    expect(robo.responder).toBe(true);
    expect(robo.escalonamento.motivo).toBe('RESERVA_PARADA');
    expect(kommo.motivo).toBe('RESERVA_PARADA');
  });

  it('fora do horario comercial avisa o lead e adia o prazo da tarefa', () => {
    const { robo } = avaliar({ canal: 'telegram', texto: 'Quero falar com alguem' }, FORA_DO_HORARIO);

    expect(robo.foraDoHorarioComercial).toBe(true);
    expect(robo.mensagens.join(' ')).toMatch(/quarta a domingo/);
    expect(robo.escalonamento.dentroDoHorarioComercial).toBe(false);
    expect(robo.escalonamento.tarefa.prazoMinutos).toBeGreaterThan(60);
  });
});

describe('Validacao de evento e descricao das regras', () => {
  it('rejeita evento sem canal', () => {
    expect(validarEvento({ texto: 'oi' })).toContain('CANAL_OBRIGATORIO');
  });

  it('rejeita canal desconhecido e tipo invalido', () => {
    const erros = validarEvento({ canal: 'pombo-correio', tipo: 'inexistente', texto: 'oi' });

    expect(erros).toContain('CANAL_DESCONHECIDO');
    expect(erros).toContain('TIPO_EVENTO_INVALIDO');
  });

  it('rejeita mensagem sem conteudo', () => {
    expect(validarEvento({ canal: 'whatsapp', tipo: 'mensagem' })).toContain('MENSAGEM_SEM_CONTEUDO');
  });

  it('aceita evento valido', () => {
    expect(validarEvento({ canal: 'whatsapp', tipo: 'mensagem', texto: 'oi' })).toEqual([]);
  });

  it('expoe as regras ativas para auditoria', () => {
    const regras = descreverRegras();

    expect(regras.entrada.limiarScore).toBe(40);
    expect(regras.robo.followUpMinutos).toEqual([120, 1440, 4320, 10080]);
    expect(Object.keys(regras.estagios).length).toBeGreaterThan(0);
  });
});

describe('Regras herdadas do projeto Chase', () => {
  it('escala na hora quando o lead sinaliza que quer avancar, mesmo sem contato', () => {
    const { robo } = avaliar({ canal: 'telegram', texto: 'Lets do it, when can he start?' });

    expect(robo.escalonamento.motivo).toBe('SINAL_CONVERSAO');
    expect(robo.escalonamento.prioridade).toBe('alta');
    expect(robo.escalonamento.resumo.dadosFaltantes.length).toBeGreaterThan(0);
    expect(robo.silenciarBot).toBe(true);
  });

  it('manda piloto que compete direto para o time, sem formulario', () => {
    const { robo, kommo } = avaliar({ canal: 'telegram', texto: 'Eu compito na Rotax, quero treinar ai' });

    expect(robo.escalonamento.motivo).toBe('PILOTO_COMPETIDOR');
    expect(robo.proximaPergunta).toBeNull();
    expect(kommo.criarCard).toBe(true);
  });

  it('classifica a experiencia pela letra respondida pelo lead', () => {
    const { analise } = avaliar({ canal: 'whatsapp', texto: 'B' });

    expect(analise.sinais.classificacaoExperiencia).toBe('B');
  });

  it('classifica a experiencia descrita em prosa', () => {
    const { analise } = avaliar({ canal: 'whatsapp', texto: 'Nunca andei de kart na vida' });

    expect(analise.sinais.classificacaoExperiencia).toBe('A');
  });

  it('nao reapresenta a abertura para lead que ja conversou', () => {
    const { robo } = avaliar({
      canal: 'telegram',
      texto: 'Oi',
      conversa: { mensagensDoLead: 4 }
    });

    expect(robo.motivo).toBe('LEAD_RETORNANTE');
    expect(robo.mensagens).toHaveLength(1);
    expect(robo.mensagens.join(' ')).not.toMatch(/Aqui e o atendimento/);
  });

  it('nenhum texto padrao contem frase proibida', () => {
    Object.values(regras.MENSAGENS).forEach(mensagem => {
      expect(frasseProibida(mensagem)).toBeNull();
    });
  });

  it('bloqueia mensagem com frase proibida antes de sair', () => {
    expect(frasseProibida('O pacote e all-inclusive')).not.toBeNull();
    expect(frasseProibida('Pode vir quando quiser, come by anytime')).not.toBeNull();
    expect(frasseProibida('Sua reserva confirmada esta garantida')).not.toBeNull();
  });

  it('remove travessao e emoji das respostas', () => {
    const { robo } = avaliar({ canal: 'whatsapp', texto: 'Tem data livre?' });

    robo.mensagens.forEach(mensagem => {
      expect(mensagem).not.toMatch(/[\u2013\u2014]/);
      expect(mensagem).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    });
  });

  it('usa o fuso de Orlando, com horario de verao', () => {
    // 2026-09-23T14:00Z = quarta, 10h em Orlando (EDT, UTC-4).
    expect(dentroDoHorarioComercial(new Date('2026-09-23T14:00:00Z'))).toBe(true);
    // 2026-12-16T14:00Z = quarta, 9h em Orlando (EST, UTC-5).
    expect(dentroDoHorarioComercial(new Date('2026-12-16T14:00:00Z'))).toBe(true);
    // 2026-12-16T13:00Z = quarta, 8h em Orlando: antes da abertura.
    expect(dentroDoHorarioComercial(new Date('2026-12-16T13:00:00Z'))).toBe(false);
  });

  it('marca o horario comercial como pendente de confirmacao', () => {
    expect(descreverRegras().robo.horarioComercial.confirmacaoPendente).toBe(true);
  });

  it('limita os re-alertas e cai em tarefa do Kommo', () => {
    const { robo } = avaliar({ canal: 'telegram', texto: 'Quero falar com alguem' });

    expect(robo.escalonamento.maxRealertas).toBe(4);
    expect(robo.escalonamento.aposMaxRealertas).toBe('criar_tarefa_no_kommo');
    expect(robo.escalonamento.notificacaoAssincrona).toBe(true);
  });
});

describe('Dois funis — Entrada recebe tudo, Comercial so lead', () => {
  const ENTRADA = { existe: true, id: '77', pipeline: 'Entrada', status: 'aberto' };

  it('codigo de verificacao fica em Automaticos e o robo nao responde', () => {
    const { kommo, robo } = avaliar({ canal: 'email', texto: 'Seu codigo de verificacao e 482913' });

    expect(kommo.acao).toBe('somente_conversa');
    expect(kommo.motivo).toBe('MENSAGEM_AUTOMATICA');
    expect(kommo.destino).toEqual({ pipeline: 'Entrada', etapa: regras.ETAPAS_ENTRADA.AUTOMATICO, mover: true });
    expect(robo.responder).toBe(false);
    expect(robo.motivo).toBe('MENSAGEM_AUTOMATICA');
  });

  it('remetente no-reply fica em Automaticos mesmo com texto comercial', () => {
    const { kommo } = avaliar({
      canal: 'email',
      texto: 'Book your next session now! Prices from $99',
      contato: { email: 'no-reply@plataforma.com' }
    });

    expect(kommo.motivo).toBe('MENSAGEM_AUTOMATICA');
    expect(kommo.entraNoComercial).toBe(false);
  });

  it('unsubscribe de newsletter nao vira opt-out', () => {
    const { analise, kommo } = avaliar({
      canal: 'email',
      texto: 'You are receiving this email because you signed up. Unsubscribe here.'
    });

    expect(analise.flags.automatico).toBe(true);
    expect(kommo.motivo).toBe('MENSAGEM_AUTOMATICA');
  });

  it('saudacao fica na Entrada aguardando contexto', () => {
    const { kommo } = avaliar({ canal: 'whatsapp', texto: 'Oi' });

    expect(kommo.destino.pipeline).toBe('Entrada');
    expect(kommo.destino.etapa).toBe(regras.ETAPAS_ENTRADA.AGUARDANDO_CONTEXTO);
  });

  it('spam vai para Ruido na Entrada', () => {
    const { kommo } = avaliar({ canal: 'whatsapp', texto: 'Nossa empresa oferece trafego pago' });

    expect(kommo.destino.etapa).toBe(regras.ETAPAS_ENTRADA.RUIDO);
  });

  it('card parado na Entrada desce para o Comercial quando aparece sinal', () => {
    const { kommo } = avaliar({ canal: 'whatsapp', texto: 'Quanto custa o coaching?', card: ENTRADA });

    expect(kommo.acao).toBe('promover_card');
    expect(kommo.criarCard).toBe(false);
    expect(kommo.entraNoComercial).toBe(true);
    expect(kommo.destino).toEqual({ pipeline: 'Comercial', etapa: regras.ESTAGIOS.QUALIFICANDO, mover: true });
  });

  it('card na Entrada sem sinal comercial continua na Entrada', () => {
    const { kommo } = avaliar({ canal: 'whatsapp', texto: 'Onde fica a pista?', card: ENTRADA });

    expect(kommo.acao).toBe('somente_conversa');
    expect(kommo.destino.pipeline).toBe('Entrada');
  });

  it('Pit ID do site promove o card da Entrada direto para Etapa 1', () => {
    const { kommo } = avaliar({
      canal: 'site',
      tipo: 'reserva_etapa1',
      reserva: { pitId: 'PIT-AB12-XYZ9', etapa: 1 },
      card: ENTRADA
    });

    expect(kommo.acao).toBe('promover_card');
    expect(kommo.destino.etapa).toBe(regras.ESTAGIOS.ETAPA1);
  });

  it('lead ja no Comercial nunca volta para a Entrada', () => {
    const { kommo } = avaliar({
      canal: 'whatsapp',
      texto: 'Obrigado!',
      card: { existe: true, pipeline: 'Comercial', status: 'fechado', fechadoEm: '2026-09-01T00:00:00Z' }
    });

    expect(kommo.destino).toEqual({ pipeline: 'Comercial', etapa: null, mover: false });
  });

  it('opt-out de lead no Comercial fecha o card como perdido', () => {
    const { kommo } = avaliar({
      canal: 'whatsapp',
      texto: 'Pare de mandar mensagem',
      card: { existe: true, pipeline: 'Comercial', status: 'aberto' }
    });

    expect(kommo.destino).toEqual({ pipeline: 'Comercial', etapa: regras.ESTAGIOS.PERDIDO, mover: true });
  });

  it('card sem funil informado conta como Comercial (nao duplica)', () => {
    const { kommo } = avaliar({ canal: 'whatsapp', texto: 'Quanto custa?', card: { existe: true, status: 'aberto' } });

    expect(kommo.acao).toBe('anexar_card');
  });

  it('com uma pessoa no comercial o handoff nao usa rodizio', () => {
    const alta = avaliar({ canal: 'telegram', texto: 'Quero falar com alguem' }).robo.escalonamento;
    const media = avaliar({ canal: 'telegram', texto: 'Tem desconto para 2 pilotos?' }).robo.escalonamento;

    expect(alta.responsavel).toBe('responsavel_unico');
    expect(alta.interromper).toBe(true);
    expect(media.interromper).toBe(false);
  });
});

describe('Mensagens automaticas vistas no Kommo da U-RACE', () => {
  it.each([
    ['Your code is 711995', 'info@account-d.docusign.net'],
    ['713157 is your code to log in to Kommo', 'mfa@kommo.com'],
    ['[Seguranca] Sua senha de acesso foi alterada', 'changed@rdstation-security.com'],
    ['Zoho Vault - O periodo de avaliacao expirou', 'notification@zohostore.com'],
    ['New deals for you', 'news@notice.alibaba.com']
  ])('"%s" (%s) fica em Automaticos', (texto, email) => {
    const { kommo } = avaliar({ canal: 'email', texto, contato: { email } });
    expect(kommo.motivo).toBe('MENSAGEM_AUTOMATICA');
  });

  it('e-mail de pessoa real nao e tratado como automatico', () => {
    const { analise } = avaliar({ canal: 'email', texto: 'Hi, how much is a training day?', contato: { email: 'carloscrestana@gmail.com' } });
    expect(analise.flags.automatico).toBe(false);
  });
});

describe('Relatorio Meta e Kommo de 25/09 (time de vendas)', () => {
  it.each([
    'Seu código para fazer login é 343929',
    'Seu código de verificação para fazer login no Dialpad',
    'Alerta de segurança para uracesim3@gmail.com',
    '[GitHub] A fine-grained personal access token has been added',
    'Reconnect your Bank of America account',
    'URace Support, you have 23 new notifications',
    'New seller message (Alibaba)',
    'URace Support, você tem 135 novas notificações',
    'Alguém adicionou este endereço como o próprio e-mail de recuperação'
  ])('card do Inbox de e-mail listado no relatorio vira nao-lead: %s', texto => {
    const { kommo, robo } = avaliar({ canal: 'email', texto });

    expect(kommo.motivo).toBe('MENSAGEM_AUTOMATICA');
    expect(kommo.entraNoComercial).toBe(false);
    expect(robo.responder).toBe(false);
  });

  it.each(['Carlos Mendes', 'Lead #15712502', 'Hi, how much is a single day?'])('nome ou pergunta de gente nao e lixo: %s', texto => {
    expect(avaliar({ canal: 'email', texto }).kommo.motivo).not.toBe('MENSAGEM_AUTOMATICA');
  });

  it.each(['instagram', 'messenger', 'whatsapp', 'site'])('no %s quem responde e o bot da equipe; o SDR so organiza', canal => {
    const { kommo, robo } = avaliar({ canal, texto: 'How much is a single day on track?' });

    expect(kommo.entraNoComercial).toBe(true);
    expect(robo.responder).toBe(false);
    expect(robo.motivo).toBe('BOT_DA_EQUIPE_NO_CANAL');
    expect(robo.escalonamento).toBeNull();
    expect(robo.followUp).toBeNull();
  });

  it('pedido de humano escrito fora do menu do bot da equipe vira tarefa, sem mensagem do SDR', () => {
    const { robo } = avaliar({ canal: 'instagram', texto: 'I want to talk to someone about a quote' });

    expect(robo.responder).toBe(false);
    expect(robo.mensagens).toEqual([]);
    expect(robo.escalonamento).toMatchObject({ motivo: 'PEDIDO_HUMANO', prioridade: 'alta' });
    expect(robo.silenciarBot).toBe(false);
  });

  it('tema sensivel em canal com bot da equipe ainda chama gente na hora', () => {
    const { robo } = avaliar({ canal: 'instagram', texto: 'Meu filho sofreu um acidente na pista ontem' });

    expect(robo.responder).toBe(false);
    expect(robo.escalonamento.prioridade).toBe('alta');
  });

  it('a trilha de follow-up da Meta cabe inteira na janela de 24 h', () => {
    const total = regras.FOLLOW_UP_MINUTOS_JANELA_24H.reduce((soma, minutos) => soma + minutos, 0);
    expect(total).toBeLessThan(regras.JANELA_MENSAGEM_LIVRE_HORAS * 60);
    expect(regras.CANAIS_JANELA_24H).toEqual(expect.arrayContaining(['whatsapp', 'instagram', 'messenger']));
  });

  it('se o dono liberar o robo no WhatsApp, o follow-up para dentro da janela de 24 h', () => {
    const botDaEquipe = regras.CANAIS_COM_BOT_DA_EQUIPE.splice(0);
    regras.CANAIS_COM_ROBO.push('whatsapp');
    try {
      const primeiro = avaliar({ canal: 'whatsapp', texto: 'Quanto custa o Summer Camp?' }).robo.followUp;
      const ultimo = avaliar({ canal: 'whatsapp', texto: 'Quanto custa o Summer Camp?', conversa: { tentativasFollowUp: 2 } }).robo.followUp;

      expect(primeiro).toMatchObject({ agendar: true, emMinutos: 120, janela24h: true, maxTentativas: 2 });
      expect(ultimo).toMatchObject({ agendar: false, acaoFinal: 'encerrar_trilha_janela_24h' });
    } finally {
      regras.CANAIS_COM_ROBO.pop();
      regras.CANAIS_COM_BOT_DA_EQUIPE.push(...botDaEquipe);
    }
  });

  it('fora da Meta (Telegram) a cadencia longa continua: +2 h, +24 h, +3 dias, +7 dias', () => {
    const { robo } = avaliar({ canal: 'telegram', texto: 'Quanto custa o Summer Camp?' });
    expect(robo.followUp).toMatchObject({ agendar: true, emMinutos: 120, janela24h: false, maxTentativas: 4 });
  });

  it('pedido de humano ganha a tag da equipe "Quer atendimento"', () => {
    expect(regras.KOMMO_MAPA.tagsPorMotivo.PEDIDO_HUMANO).toEqual(['Quer atendimento']);
  });
});
