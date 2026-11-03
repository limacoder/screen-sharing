# Telão

Compartilhamento de tela com áudio para duas pessoas, direto de um navegador para o outro (WebRTC). O servidor só apresenta os dois lados: vídeo e áudio não passam por ele.

## Como usar

Quem hospeda precisa do Node 20 ou mais novo:

```
npm install
npm start
```

O link público abre no navegador. Clique em **Criar sala**, depois em **Copiar link da sala**, e mande para a outra pessoa. Deixe o terminal aberto enquanto usarem. O link muda a cada `npm start`.

A outra pessoa só precisa abrir o link no **Chrome ou Edge** e clicar em **Entrar na sala**. Qualquer um dos dois pode compartilhar, inclusive ao mesmo tempo.

Ao compartilhar, escolha **Tela inteira** e ligue a opção de **áudio do sistema**, que vem desligada. Abas enviam só o áudio da própria aba, e janelas nem sempre têm a opção de áudio. Se a transmissão sair sem áudio, um aviso aparece na tela com um botão para compartilhar de novo.

## Qualidade

**Resolução:** o padrão reduz para a tela de quem assiste, então um monitor 4K chega a 1080p numa tela 1080p, com bitrate de até 12 Mbps. Em **Qualidade** dá para forçar 4K (até 40 Mbps).

**Quadros por segundo:** 60 fps é o pedido, mas quem limita é a captura do próprio Chrome. Medido num Ryzen 5600X com RX 7800 XT, Chrome 156 e monitor 4K, com a tela sempre em movimento a 60 fps:

| Origem | Enviando em 1080p | Enviando em 4K |
|---|---|---|
| Tela inteira | 31 a 38 fps | 25 a 31 fps |
| Janela | 44 fps | 40 fps |

Os quadros se perdem na captura, antes do encoder. Tela parada também mostra poucos fps, e isso é normal: só vão quadros quando algo muda.

Abra **Estatísticas** para ver o que está acontecendo de verdade.

**Codec:** o automático prefere AV1, VP9 e H.264 por hardware e cai para VP9 por software. O H.265 fica de fora porque derrubou a aba de quem compartilha em 4 de 6 tentativas.

## Áudio

Por padrão vai todo o som do computador. Se o som não chegar, abra **Estatísticas** nos dois lados: **Áudio enviado** e **Áudio recebido** mostram o nível em cada ponta e em qual delas ele para.

**Eco:** o áudio do sistema leva junto a voz de quem fala com você, seja numa call do Discord ou pelo microfone daqui, e essa pessoa ouve o próprio eco. Há duas saídas:

- **Conteúdo no navegador:** compartilhe só a aba em vez da tela inteira, e vai apenas o som dela.
- **Jogo ou outro programa:** usem **Ligar microfone** aqui e escolham **Sem o som do Chrome** em **Qualidade**, antes de compartilhar. A voz toca no Chrome e fica de fora, mas o som de todas as outras abas do Chrome também fica.

## Se não conectar

O status mostra se a conexão é **direta** ou **via relay**. Se aparecer "Sem rota entre vocês", o provedor de um dos lados está bloqueando a conexão direta (comum com CGNAT). Nesse caso é preciso um servidor TURN, que retransmite a mídia e consome a banda dele:

```
TURN_URLS=turn:seu-servidor:3478 TURN_USERNAME=usuario TURN_CREDENTIAL=senha npm start
```

## Link fixo

`npm start` usa um túnel temporário da Cloudflare, sem conta. Para ter um endereço fixo, hospede o projeto em qualquer serviço Node com HTTPS e WebSocket usando `npm run local`, que respeita a variável `PORT`. Sem HTTPS o navegador não deixa compartilhar a tela.

## Testes

`npm test` roda tudo, inclusive dois Chromes de verdade em modo headless, com tela e microfone falsos. Precisa do Chrome instalado.
