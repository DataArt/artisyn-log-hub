import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';
import { useState } from 'react';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '../../ui/table';

interface AdminDataTableProps<TData> {
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  globalFilter: string;
  getRowClassName?: (row: TData) => string;
}

export function AdminDataTable<TData>({
  columns,
  data,
  globalFilter,
  getRowClassName,
}: AdminDataTableProps<TData>) {
  const [sorting, setSorting] = useState<SortingState>(() => {
    const firstId = columns[0]?.id;
    return firstId ? [{ id: firstId, desc: false }] : [];
  });

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {headerGroup.headers.map((header) => {
              const sortDir = header.column.getIsSorted();
              return (
                <TableHead
                  key={header.id}
                  onClick={header.column.getToggleSortingHandler()}
                  className={
                    header.column.getCanSort()
                      ? 'cursor-pointer select-none'
                      : ''
                  }
                >
                  <span className="inline-flex items-center gap-1">
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                    {header.column.getCanSort() && (
                      <>
                        {sortDir === 'asc' && <ArrowUp className="h-3 w-3" />}
                        {sortDir === 'desc' && (
                          <ArrowDown className="h-3 w-3" />
                        )}
                        {sortDir === false && (
                          <ArrowUpDown className="h-3 w-3 opacity-40" />
                        )}
                      </>
                    )}
                  </span>
                </TableHead>
              );
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.length === 0 ? (
          <TableRow>
            <TableCell
              colSpan={columns.length}
              className="h-24 text-center text-muted-foreground"
            >
              No results.
            </TableCell>
          </TableRow>
        ) : (
          table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              className={getRowClassName?.(row.original) ?? ''}
            >
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
