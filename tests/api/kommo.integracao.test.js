// Integracao com o Kommo: mapa para os funis da equipe (Urace -> Comercial),
// webhook de mensagens e de leads criados, acoes no card. O Kommo falso parte
// da estrutura real da conta (fixture).
const request = require('supertest');
const kommo = require('../../lib/kommo');
const { regras } = require('../../lib/sdr');
const { createApp } = require('../../server');
const FIXTURE = require('./fixtures/kommo-funis.json');

// IDs reais (urace.kommo.com).
const URACE = 9903543;
const FIRST_CONTACT = 105276412;
const COLD_LEADS = 77188783;
const HOT_LEADS = 78606031;
const INCOMING_URACE = 76050835;
const CONTACT_LIST = 9957459;
const INTERACTIONS = 76442723;
const COMERCIAL = 14512484;
const ENTRADA = 112100844;
const QUALIFICADO = 112100848;
const ATENDIMENTO = 112100852;
const PROPOSTA = 112113592;
const PERDIDO_NQ = 112113604;

function criarKommoFalso(pipelines = FIXTURE.pipelines) {
  let proximoId = 900000;
  const estado = {
    pipelines: JSON.parse(JSON.stringify(pipelines)),
    leads: {},
    chamadas: [],
    notas: [],
    tarefas: [],
    webhooks: []
  };

  async function fetchImpl(url, opcoes) {
    const caminho = url.replace('https://urace.kommo.com/api/v4', '');
    const metodo = opcoes.method;
    const corpo = opcoes.body ? JSON.parse(opcoes.body) : null;
    estado.chamadas.push({ metodo, caminho, corpo });

    const responder = (status, dados) => ({
      ok: status < 400,
      status,
      text: async () => (dados === undefined ? '' : JSON.stringify(dados))
    });

    if (metodo === 'GET' && caminho === '/leads/pipelines') {
      return responder(200, { _embedded: { pipelines: estado.pipelines } });
    }
    if (metodo === 'POST' && caminho === '/leads/pipelines') {
      corpo.forEach(p => estado.pipelines.push({
        id: proximoId++,
        name: p.name,
        sort: p.sort,
        _embedded: { statuses: p._embedded.statuses.map(s => ({ id: proximoId++, name: s.name, sort: s.sort, type: 0 })) }
      }));
      return responder(200, {});
    }
    const lead = caminho.match(/^\/leads\/(\d+)$/);
    if (lead && metodo === 'GET') {
      const encontrado = estado.leads[lead[1]];
      return encontrado ? responder(200, encontrado) : responder(404, { title: 'Not found' });
    }
    if (lead && metodo === 'PATCH') {
      const alvo = estado.leads[lead[1]];
      if (corpo.pipeline_id) alvo.pipeline_id = corpo.pipeline_id;
      if (corpo.status_id) alvo.status_id = corpo.status_id;
      (corpo.tags_to_add || []).forEach(tag => alvo._embedded.tags.push(tag));
      return responder(200, alvo);
    }
    const nota = caminho.match(/^\/leads\/(\d+)\/notes$/);
    if (nota && metodo === 'POST') {
      estado.notas.push({ leadId: nota[1], texto: corpo[0].params.text });
      return responder(200, {});
    }
    if (caminho === '/tasks' && metodo === 'POST') {
      estado.tarefas.push(corpo[0]);
      return responder(200, {});
    }
    if (caminho === '/webhooks' && metodo === 'GET') {
      return responder(200, { _embedded: { webhooks: estado.webhooks } });
    }
    if (caminho === '/webhooks' && metodo === 'POST') {
      estado.webhooks.push(corpo);
      return responder(200, corpo);
    }
    return responder(404, { title: 'rota falsa inexistente', caminho });
  }

  function criarLead(id, pipelineId, statusId, extras = {}) {
    estado.leads[id] = {
      id,
      pipeline_id: pipelineId,
      status_id: statusId,
      responsible_user_id: 555,
      updated_at: 1790000000,
      closed_at: null,
      _embedded: { tags: [] },
      ...extras
    };
    return estado.leads[id];
  }

  const escritas = () => estado.chamadas.filter(c => c.metodo !== 'GET');

  return { estado, fetchImpl, criarLead, escritas };
}

const silencioso = { log: () => {}, error: () => {} };

function integracaoPara(falso, extras = {}) {
  const cliente = kommo.criarClienteKommo({ subdominio: 'urace', token: 't', fetchImpl: falso.fetchImpl });
  return kommo.criarIntegracaoKommo({
    cliente,
    obterMapa: kommo.criarResolvedorDeMapa(cliente),
    log: silencioso,
    modo: 'aplicar',
    ...extras
  });
}

function mensagem(leadId, texto, extras = {}) {
  return {
    message: {
      add: {
        0: {
          id: extras.id || `m-${Math.random()}`,
          text: texto,
          type: extras.type || 'incoming',
          element_type: '2',
          element_id: String(leadId),
          contact_id: '9',
          chat_id: 'chat-1',
          origin: extras.origin || 'waba'
        }
      }
    }
  };
}

function leadCriado(leadId, nome) {
  return { leads: { add: { 0: { id: String(leadId), name: nome, pipeline_id: String(URACE), status_id: String(FIRST_CONTACT) } } } };
}

const ENV = { KOMMO_SUBDOMINIO: 'urace', KOMMO_TOKEN: 'tok' };
const tags = lead => lead._embedded.tags.map(t => t.name);

describe('Kommo — estrutura: funis da equipe, nada criado', () => {
  it('o mapa aponta para Urace e Comercial e tudo que ele usa existe na conta', () => {
    const plano = kommo.planejarEstrutura(FIXTURE.pipelines);

    expect(regras.KOMMO_MAPA.pipelines).toEqual({ Entrada: 'Urace', Comercial: 'Comercial' });
    expect(plano.ok).toBe(true);
    expect(plano.pipelinesFaltando).toEqual([]);
    expect(plano.etapasFaltando).toEqual([]);
    expect(plano.etapasDuplicadas).toEqual([]);
  });

  it('conferir a estrutura nunca escreve, nem com aplicar', async () => {
    const falso = criarKommoFalso();
    const integracao = kommo.criarIntegracaoDoAmbiente(ENV, falso.fetchImpl);

    const resultado = await integracao.sincronizarEstrutura({ aplicar: true });

    expect(resultado.aplicado).toBe(false);
    expect(resultado.mapa.Entrada.id).toBe(URACE);
    expect(resultado.mapa.Comercial.id).toBe(COMERCIAL);
    expect(falso.escritas()).toHaveLength(0);
  });

  it('etapa renomeada no Kommo vira pendencia, sem criar nada', async () => {
    const falso = criarKommoFalso();
    const comercial = falso.estado.pipelines.find(p => p.id === COMERCIAL);
    comercial._embedded.statuses.find(st => st.id === ATENDIMENTO).name = 'EM ATENDIMENTO';
    const integracao = kommo.criarIntegracaoDoAmbiente(ENV, falso.fetchImpl);

    const resultado = await integracao.sincronizarEstrutura({ aplicar: true });

    expect(resultado.plano.ok).toBe(false);
    expect(resultado.plano.etapasFaltando).toEqual([{ pipeline: 'Comercial', etapa: 'ATENDIMENTO' }]);
    expect(falso.escritas()).toHaveLength(0);
  });

  it('sem configuracao nao cria integracao; com configuracao comeca em observar', () => {
    expect(kommo.criarIntegracaoDoAmbiente({})).toBeNull();
    expect(kommo.criarIntegracaoDoAmbiente(ENV).modo).toBe('observar');
    expect(kommo.criarIntegracaoDoAmbiente({ ...ENV, KOMMO_MODO: 'aplicar' }).modo).toBe('aplicar');
  });

  it('webhook assina mensagem recebida e lead criado; completa assinatura antiga', async () => {
    const falso = criarKommoFalso();
    const integracao = kommo.criarIntegracaoDoAmbiente(ENV, falso.fetchImpl);
    const url = 'https://sdr.urace.us/api/kommo/webhook?token=x';
    falso.estado.webhooks.push({ destination: url, settings: ['add_message'] });

    const primeiro = await integracao.registrarWebhook(url);
    falso.estado.webhooks[0].settings = ['add_message', 'add_lead'];
    const segundo = await integracao.registrarWebhook(url);

    expect(primeiro).toMatchObject({ registrado: true, atualizado: true, eventos: ['add_message', 'add_lead'] });
    expect(segundo).toEqual({ registrado: false, motivo: 'JA_EXISTE' });
  });
});

describe('Kommo — pagina 1 (Urace): o SDR complementa as REGRAS 1 e 2', () => {
  it('converte o corpo form-urlencoded do Kommo', () => {
    const corpo = kommo.parseCorpoWebhook(
      'message%5Badd%5D%5B0%5D%5Btext%5D=Oi&message%5Badd%5D%5B0%5D%5Belement_id%5D=42&message%5Badd%5D%5B0%5D%5Belement_type%5D=2'
        + '&leads%5Badd%5D%5B0%5D%5Bid%5D=77&leads%5Badd%5D%5B0%5D%5Bname%5D=New+seller+message',
      'application/x-www-form-urlencoded'
    );
    const [msg] = kommo.extrairMensagensRecebidas(corpo);
    const [lead] = kommo.extrairLeadsCriados(corpo);

    expect(msg.texto).toBe('Oi');
    expect(msg.leadId).toBe('42');
    expect(lead).toEqual({ id: '77', nome: 'New seller message', pipelineId: null, statusId: null });
  });

  it('lead novo com nome de e-mail de sistema ganha nao_e_lead antes da REGRA 1', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(1, URACE, FIRST_CONTACT, { name: 'Seu código para fazer login é 343929' });

    const [resultado] = await integracaoPara(falso).receberWebhook(leadCriado(1, 'Seu código para fazer login é 343929'));

    expect(resultado.acao).toBe('marcar_nao_e_lead');
    expect(tags(falso.estado.leads[1])).toEqual(expect.arrayContaining(['nao_e_lead', 'sdr:automatico']));
    expect(tags(falso.estado.leads[1])).not.toContain('DM');
    expect(falso.estado.leads[1].status_id).toBe(FIRST_CONTACT);
  });

  it('lead novo com nome de gente e da equipe: o SDR nao escreve nada', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(2, URACE, FIRST_CONTACT, { name: 'Carlos Mendes' });

    const [resultado] = await integracaoPara(falso).receberWebhook(leadCriado(2, 'Carlos Mendes'));

    expect(resultado.ignorado).toBe('LEAD_DA_EQUIPE');
    expect(falso.escritas()).toHaveLength(0);
  });

  it('em modo observar o lixo e reconhecido mas nada e escrito', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(3, URACE, FIRST_CONTACT, { name: 'Reconnect your Bank of America account' });

    const [resultado] = await integracaoPara(falso, { modo: 'observar' }).receberWebhook(leadCriado(3, 'x'));

    expect(resultado).toMatchObject({ modo: 'observar', acao: 'marcar_nao_e_lead', tags: expect.arrayContaining(['nao_e_lead']) });
    expect(falso.escritas()).toHaveLength(0);
  });

  it('pergunta de preco em First Contact fica para a REGRA 2 subir: o SDR nao move', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(4, URACE, FIRST_CONTACT);

    const [resultado] = await integracaoPara(falso).receberWebhook(mensagem(4, 'How much is a single day on track?', { origin: 'instagram' }));

    expect(resultado.segurado).toBe('REGRA_2_DA_EQUIPE');
    expect(resultado.moveu).toBe(false);
    expect(falso.estado.leads[4].pipeline_id).toBe(URACE);
    expect(falso.estado.leads[4].status_id).toBe(FIRST_CONTACT);
    expect(tags(falso.estado.leads[4])).toContain('sdr:intencao-comercial');
    expect(tags(falso.estado.leads[4])).not.toContain('DM');
    expect(falso.estado.notas).toHaveLength(0);
  });

  it('codigo de login por mensagem em First Contact ganha nao_e_lead e fica', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(5, URACE, FIRST_CONTACT);

    await integracaoPara(falso).receberWebhook(mensagem(5, '713157 is your code to log in to Kommo', { origin: 'email' }));

    expect(falso.estado.leads[5].status_id).toBe(FIRST_CONTACT);
    expect(tags(falso.estado.leads[5])).toEqual(expect.arrayContaining(['sdr:automatico', 'nao_e_lead']));
  });

  it('pedido de humano fora do menu do bot vira tarefa para o responsavel, sem mover', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(6, URACE, FIRST_CONTACT);
    const agora = new Date('2026-09-23T14:00:00Z');

    const resultado = await integracaoPara(falso, { responsavelId: '777' }).processarMensagem(
      kommo.extrairMensagensRecebidas(mensagem(6, 'I want to talk to someone please', { origin: 'instagram' }))[0],
      agora
    );

    expect(resultado.segurado).toBe('REGRA_2_DA_EQUIPE');
    expect(resultado.tarefa.prioridade).toBe('alta');
    expect(falso.estado.tarefas[0].responsible_user_id).toBe(777);
    expect(falso.estado.notas[0].texto).toContain('HANDOFF ALTA');
    expect(tags(falso.estado.leads[6])).toEqual(expect.arrayContaining(['Quer atendimento', 'sdr:handoff']));
    expect(tags(falso.estado.leads[6])).not.toContain('sdr:bot-silenciado');
    expect(falso.estado.leads[6].status_id).toBe(FIRST_CONTACT);
  });

  it('opt-out fecha como perdido com a tag opt_out', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(7, URACE, FIRST_CONTACT);

    await integracaoPara(falso).receberWebhook(mensagem(7, 'Pare de mandar mensagem'));

    expect(falso.estado.leads[7].status_id).toBe(143);
    expect(tags(falso.estado.leads[7])).toContain('opt_out');
  });

  it('conversa enterrada em Cold Leads que volta pedindo preco sobe para Comercial > ENTRADA com DM', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(8, URACE, COLD_LEADS);

    const [resultado] = await integracaoPara(falso).receberWebhook(mensagem(8, 'Hi again, how much for a day?', { origin: 'instagram' }));

    expect(resultado.acao).toBe('promover_card');
    expect(falso.estado.leads[8].pipeline_id).toBe(COMERCIAL);
    expect(falso.estado.leads[8].status_id).toBe(ENTRADA);
    expect(tags(falso.estado.leads[8])).toContain('DM');
    expect(falso.estado.notas[0].texto).toContain('promover_card');
  });

  it('card resgatado que ja tem tag de origem nao ganha DM', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(9, URACE, COLD_LEADS, { _embedded: { tags: [{ name: 'Meta_Ads' }] } });

    await integracaoPara(falso).receberWebhook(mensagem(9, 'Quanto custa o coaching?'));

    expect(falso.estado.leads[9].status_id).toBe(ENTRADA);
    expect(tags(falso.estado.leads[9])).not.toContain('DM');
  });

  it('Cold Leads sem sinal comercial continua onde esta', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(10, URACE, COLD_LEADS);

    const [resultado] = await integracaoPara(falso).receberWebhook(mensagem(10, 'Obrigado!'));

    expect(resultado.ignorado).toBe('RESGATE_SEM_SINAL');
    expect(falso.escritas()).toHaveLength(0);
  });

  it('Hot Leads e as demais etapas em trabalho na Urace nao sao do SDR', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(11, URACE, HOT_LEADS);

    const [resultado] = await integracaoPara(falso).receberWebhook(mensagem(11, 'Quanto custa?'));

    expect(resultado.ignorado).toBe('ETAPA_DA_EQUIPE');
    expect(falso.escritas()).toHaveLength(0);
  });

  it('lead perdido na Urace que volta pedindo agenda sobe para o Comercial', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(12, URACE, 143, { closed_at: Math.floor(Date.now() / 1000) - 5 * 86400 });

    const [resultado] = await integracaoPara(falso).receberWebhook(mensagem(12, 'Tem vaga no sabado? Quanto custa?'));

    expect(resultado.acao).toBe('promover_card');
    expect(falso.estado.leads[12].pipeline_id).toBe(COMERCIAL);
    expect(falso.estado.leads[12].status_id).toBe(ENTRADA);
  });

  it('Incoming leads nao e mexido (o Kommo nao deixa mover por PATCH)', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(13, URACE, INCOMING_URACE);

    const [resultado] = await integracaoPara(falso).receberWebhook(mensagem(13, 'Quanto custa?'));

    expect(resultado.ignorado).toBe('INCOMING_LEADS');
  });
});

describe('Kommo — pagina 2 (Comercial) e demais funis', () => {
  it('pedido de humano em ENTRADA vira tarefa e nota; a etapa e do vendedor', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(20, COMERCIAL, ENTRADA);

    const [resultado] = await integracaoPara(falso, { responsavelId: '777' }).receberWebhook(mensagem(20, 'Quero falar com alguem'));

    expect(resultado.acao).toBe('anexar_card');
    expect(resultado.tarefa.prioridade).toBe('alta');
    expect(falso.estado.leads[20].status_id).toBe(ENTRADA);
    expect(falso.estado.notas[0].texto).toContain('HANDOFF ALTA');
  });

  it('perdido no Comercial ha 5 dias que volta pedindo agenda reabre em ENTRADA', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(28, COMERCIAL, 143, { closed_at: Math.floor(Date.now() / 1000) - 5 * 86400 });

    const [resultado] = await integracaoPara(falso).receberWebhook(mensagem(28, 'Tem vaga no sabado? Quanto custa?'));

    expect(resultado.acao).toBe('reabrir_card');
    expect(falso.estado.leads[28].status_id).toBe(ENTRADA);
  });

  it('opt-out no Comercial vai para PERDIDO / NAO QUALIFICADO', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(21, COMERCIAL, QUALIFICADO);

    await integracaoPara(falso).receberWebhook(mensagem(21, 'Pare de mandar mensagem'));

    expect(falso.estado.leads[21].status_id).toBe(PERDIDO_NQ);
    expect(tags(falso.estado.leads[21])).toContain('opt_out');
  });

  it('o SDR nunca devolve card para etapa anterior', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(22, COMERCIAL, PROPOSTA);
    const cliente = kommo.criarClienteKommo({ subdominio: 'urace', token: 't', fetchImpl: falso.fetchImpl });
    const mapa = await kommo.criarResolvedorDeMapa(cliente)();
    const decisao = require('../../lib/sdr').avaliarInteracao({
      canal: 'site',
      tipo: 'reserva_etapa1',
      reserva: { pitId: 'PIT-AB12-XYZ9', etapa: 1 },
      card: { existe: true, id: '22', pipeline: 'Comercial', status: 'aberto' }
    });

    const feito = await kommo.aplicarDecisao(cliente, falso.estado.leads[22], decisao, mapa, { modo: 'aplicar' });

    expect(feito.naoVoltou).toEqual({ de: 'proposta', para: regras.ESTAGIOS.ETAPA1 });
    expect(falso.estado.leads[22].status_id).toBe(PROPOSTA);
  });

  it('Driver Briefing concluido fecha como ganho (142)', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(23, COMERCIAL, QUALIFICADO);
    const cliente = kommo.criarClienteKommo({ subdominio: 'urace', token: 't', fetchImpl: falso.fetchImpl });
    const mapa = await kommo.criarResolvedorDeMapa(cliente)();
    const decisao = require('../../lib/sdr').avaliarInteracao({
      canal: 'site',
      tipo: 'reserva_etapa2',
      reserva: { pitId: 'PIT-AB12-XYZ9', etapa: 2 },
      card: { existe: true, id: '23', pipeline: 'Comercial', status: 'aberto' }
    });

    await kommo.aplicarDecisao(cliente, falso.estado.leads[23], decisao, mapa, { modo: 'aplicar' });

    expect(falso.estado.leads[23].status_id).toBe(142);
  });

  it('contato antigo em outro funil (Contact list) com sinal comercial: aviso, sem mover', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(24, CONTACT_LIST, INTERACTIONS);
    const integracao = integracaoPara(falso, { responsavelId: '777' });

    const [resultado] = await integracao.receberWebhook(mensagem(24, 'Hey, how much is the Academy now?', { origin: 'instagram' }));
    const [repetido] = await integracao.receberWebhook(mensagem(24, 'Quanto custa?'));

    expect(resultado).toMatchObject({ acao: 'avisar_contato_antigo', funil: 'Contact list', moveu: false });
    expect(falso.estado.leads[24].pipeline_id).toBe(CONTACT_LIST);
    expect(falso.estado.tarefas).toHaveLength(1);
    expect(falso.estado.tarefas[0].responsible_user_id).toBe(777);
    expect(falso.estado.notas[0].texto).toContain('contato antigo');
    expect(repetido.ignorado).toBe('AVISO_JA_ENVIADO');
  });

  it('contato antigo sem sinal comercial em outro funil: nada', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(25, CONTACT_LIST, INTERACTIONS);

    const [resultado] = await integracaoPara(falso).receberWebhook(mensagem(25, 'Obrigado!'));

    expect(resultado.ignorado).toBe('PIPELINE_FORA_DO_SDR');
    expect(falso.escritas()).toHaveLength(0);
  });

  it('mensagem da equipe (outgoing) e repetida sao ignoradas', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(26, COMERCIAL, ENTRADA);
    const integracao = integracaoPara(falso);

    expect(await integracao.receberWebhook(mensagem(26, 'Quero falar com alguem', { type: 'outgoing' }))).toHaveLength(0);

    const corpo = mensagem(26, 'Quero falar com alguem', { id: 'repetida' });
    await integracao.receberWebhook(corpo);
    const [segunda] = await integracao.receberWebhook(corpo);
    expect(segunda.ignorado).toBe('DUPLICADA');
    expect(falso.estado.notas).toHaveLength(1);
  });

  it('lead criado fora de First Contact nao e do SDR', async () => {
    const falso = criarKommoFalso();
    falso.criarLead(27, COMERCIAL, ATENDIMENTO, { name: 'New seller message (Alibaba)' });

    const [resultado] = await integracaoPara(falso).receberWebhook(leadCriado(27, 'x'));

    expect(resultado.ignorado).toBe('FORA_DE_FIRST_CONTACT');
    expect(falso.escritas()).toHaveLength(0);
  });
});

describe('Kommo — rotas', () => {
  const ENV_ORIGINAL = { ...process.env };

  afterEach(() => {
    process.env = { ...ENV_ORIGINAL };
  });

  function appCom(integracao) {
    return createApp({ kommo: integracao, repo: {}, configRepo: {}, emailService: {} });
  }

  it('webhook sem integracao configurada responde 503', async () => {
    const resposta = await request(appCom(null)).post('/api/kommo/webhook?token=x').send('a=1');
    expect(resposta.status).toBe(503);
  });

  it('webhook com token errado responde 401', async () => {
    process.env.KOMMO_WEBHOOK_TOKEN = 'segredo';
    const resposta = await request(appCom({ receberWebhook: jest.fn() })).post('/api/kommo/webhook?token=errado').send('a=1');
    expect(resposta.status).toBe(401);
  });

  it('webhook valido responde na hora e processa em segundo plano', async () => {
    process.env.KOMMO_WEBHOOK_TOKEN = 'segredo';
    const receberWebhook = jest.fn().mockResolvedValue([]);

    const resposta = await request(appCom({ receberWebhook }))
      .post('/api/kommo/webhook?token=segredo')
      .type('form')
      .send('message[add][0][text]=Oi&message[add][0][element_id]=1&message[add][0][element_type]=2');

    expect(resposta.status).toBe(200);
    expect(resposta.body.recebidas).toBe(1);
    expect(receberWebhook.mock.calls[0][0].message.add['0'].text).toBe('Oi');
  });

  it('estrutura exige o token administrativo definido', async () => {
    delete process.env.SDR_WEBHOOK_TOKEN;
    const resposta = await request(appCom({ sincronizarEstrutura: jest.fn() })).post('/api/kommo/estrutura').send({});
    expect(resposta.status).toBe(401);
  });

  it('estrutura sem aplicar so devolve o plano', async () => {
    process.env.SDR_WEBHOOK_TOKEN = 'admin';
    const sincronizarEstrutura = jest.fn().mockResolvedValue({ aplicado: false, plano: { ok: true } });

    const resposta = await request(appCom({ sincronizarEstrutura }))
      .post('/api/kommo/estrutura')
      .set('Authorization', 'Bearer admin')
      .send({});

    expect(resposta.status).toBe(200);
    expect(sincronizarEstrutura).toHaveBeenCalledWith({ aplicar: false });
  });
});

describe('Servico enxuto do SDR (sdr-server.js)', () => {
  const { createSdrApp } = require('../../sdr-server');
  const ENV_ORIGINAL = { ...process.env };

  afterEach(() => {
    process.env = { ...ENV_ORIGINAL };
  });

  it('sobe sem Firebase e informa o modo do Kommo', async () => {
    const resposta = await request(createSdrApp({ kommo: { modo: 'observar' } })).get('/health');

    expect(resposta.status).toBe(200);
    expect(resposta.body).toEqual({ ok: true, service: 'sdr-agent-urace', kommo: 'observar' });
  });

  it('avalia interacoes pela mesma rota do backend completo', async () => {
    delete process.env.SDR_WEBHOOK_TOKEN;
    const resposta = await request(createSdrApp({ kommo: null }))
      .post('/api/sdr/avaliar')
      .send({ canal: 'whatsapp', texto: 'Quanto custa o coaching?' });

    expect(resposta.status).toBe(200);
    expect(resposta.body.kommo.entraNoComercial).toBe(true);
  });

  it('recebe o webhook do Kommo e processa em segundo plano', async () => {
    process.env.KOMMO_WEBHOOK_TOKEN = 'segredo';
    const receberWebhook = jest.fn().mockResolvedValue([]);

    const resposta = await request(createSdrApp({ kommo: { receberWebhook } }))
      .post('/api/kommo/webhook?token=segredo')
      .type('form')
      .send('message[add][0][text]=Oi&message[add][0][element_id]=1&message[add][0][element_type]=2');

    expect(resposta.status).toBe(200);
    expect(receberWebhook).toHaveBeenCalledTimes(1);
  });

  it('rota desconhecida responde 404', async () => {
    const resposta = await request(createSdrApp({ kommo: null })).get('/api/reservas');
    expect(resposta.status).toBe(404);
  });
});
