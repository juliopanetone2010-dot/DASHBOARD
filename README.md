# ROI Dashboard

Crie um dashboard de ROI para arbitragem com foco em Google Ads e monetização (Ad Manager).

O sistema deve ter:

1. Tela principal com métricas:

- Gasto (Google Ads)

- Receita (Ad Manager)

- Lucro

- ROI (%)

2. Tabela de campanhas contendo:

- campaignId

- nome da campanha

- gasto

- receita

- lucro

- ROI

3. Inputs para adicionar dados manualmente:

- gasto por campanha

- receita por campanha

4. Cálculos automáticos:

- lucro = receita - gasto

- ROI = (lucro / gasto) * 100

5. Interface moderna:

- estilo dashboard (cards no topo)

- cores:

  - verde (lucro positivo)

  - vermelho (prejuízo)

6. Filtros:

- por campanha

- por data (simples)

7. Botão para atualizar dados

8. Estrutura preparada para futura integração com APIs:

- Google Ads

- Google Ad Manager

9. Código simples e limpo (sem backend complexo)

Objetivo: Quero um dashboard funcional primeiro, depois evoluir para automação completa.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://ad-genius-tracker.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/9ae3bea8-15b6-4d8c-a8f6-8d528e13cce2).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
