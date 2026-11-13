# Status

Estado de um ativo com o componente `status` do Tabler: ponto de cor + rótulo.

| Estado | Classe |
|---|---|
| Em produção | `status status-green` |
| Em stock | `status status-azure` |
| Planeado | `status status-secondary` |
| Em manutenção | `status status-orange` |
| Abatido | `status status-secondary text-decoration-line-through` |

- Use sempre o rótulo; o ponto sozinho não chega.
- Criticidade não é um estado: use `Badge` (Baixa `bg-secondary-lt`, Média `bg-azure-lt`, Alta `bg-orange-lt`, Crítica `bg-red-lt`).
