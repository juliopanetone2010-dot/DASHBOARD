## Objetivo

Tornar a `CampaignsTable` totalmente customizável: permitir **reordenar** e **redimensionar** todas as colunas (incluindo a coluna de "Ações" — Pause / CPA / Orç / Histórico / Reiniciar / HTML5, que passam a ser tratadas como colunas independentes).

## Mudanças

### 1. Tratar cada ação como coluna independente

Hoje as 6 ações vivem dentro de um único `<TableCell>` fixo no fim. Vou separá-las em colunas próprias:

- `act_pause` — botão Pause/Play
- `act_cpa` — InlineMoneyEdit CPA
- `act_budget` — InlineMoneyEdit Orçamento
- `act_history` — botão Histórico
- `act_restart` — botão Reiniciar
- `act_html5` — botão HTML5

Cada uma vira opção no menu "Colunas" (já existente) e pode ser ocultada individualmente.

### 2. Reordenar colunas (drag & drop)

No dropdown **Colunas (X/Y)** que já existe, cada item passa a ter:
- Checkbox de visibilidade (já existe)
- **Handle de drag** (ícone `GripVertical`) para reordenar
- Setas ▲ ▼ como fallback acessível

Drag implementado com `@dnd-kit/core` + `@dnd-kit/sortable` (libs já leves, sem dependência nova pesada — se não estiverem instaladas, adicionar).

Ordem persistida em `localStorage` (`campaigns-table-column-order-v1`) junto com a visibilidade já persistida.

Colunas **fixas** (não reordenáveis nem ocultáveis): Checkbox, Campaign ID, Nome, Final URL. As demais (incluindo Score, métricas e todas as ações) entram no pool reordenável.

### 3. Redimensionar colunas

Adicionar handle de resize (`col-resize` cursor) na borda direita de cada `<TableHead>` reordenável. Mouse drag ajusta a largura. Larguras persistidas em `localStorage` (`campaigns-table-column-widths-v1`).

- Width mínima: 60px, máxima: 600px.
- Reset disponível no menu "Colunas" → "Restaurar padrão" (já podemos adicionar).
- Aplicado via `style={{ width, minWidth }}` no `<TableHead>` e no `<TableCell>` correspondente.

### 4. Renderização dinâmica das linhas

Hoje as células de cada linha estão hardcoded em ordem. Refatorar para um map sobre `orderedVisibleColumns`, onde cada coluna tem um `renderCell(c, ctx)` que retorna o JSX da célula. Isso permite a renderização respeitar a ordem escolhida pelo usuário.

Mantém as 4 colunas sticky iniciais como hoje (sem reorder, fora do map).

## Arquivos

- editar: `src/components/dashboard/CampaignsTable.tsx` (refator principal)
- novo: `src/components/dashboard/campaignsTableColumns.tsx` — definição declarativa de cada coluna (`{ key, label, sortKey?, render(c, ctx), defaultWidth, headerAlign }`)
- novo: `src/components/dashboard/ColumnManagerDropdown.tsx` — dropdown reusável com drag (dnd-kit) + checkboxes + reset
- novo (se necessário): instalar `@dnd-kit/core` e `@dnd-kit/sortable`

## Detalhes técnicos

- `useColumnLayout()` hook retorna `{ order, widths, visible, setOrder, setWidth, toggleVisible, resetAll }` com persistência em localStorage.
- Drag-resize: `onPointerDown` no handle → captura `pointermove`/`pointerup` no window, calcula `newWidth = startWidth + (e.clientX - startX)`, clamped 60–600.
- Para evitar pulo visual durante o resize, aplicar a largura via state diretamente (sem debounce); persistir no `pointerup`.
- A coluna "Ações" deixa de existir como bloco único; cada botão é uma coluna estreita (default 56px para botões simples, 110px para `InlineMoneyEdit`).
- Sort permanece igual nas colunas que já tinham `SortHead`; ações não são ordenáveis.

## Fora do escopo

- Não vamos permitir reordenar/ocultar Checkbox, Campaign ID, Nome ou Final URL (essas seguem sticky).
- Sem mudanças em dados, queries, edge functions ou schema.
- Sem mudar a lógica de filtros, sort default, ou tendência.
