import React, { useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { documentsApi } from '../../services/endpoints';
import { ApiError, errorMessage } from '../../services/api';
import { keys } from '../../hooks/queries';
import { Banner, Card, EmptyState, ErrorState, Loading, Row, layout } from '../../components/ui';
import { colors } from '../../theme';
import { formatDate } from '../../utils/date';
import { titleCase } from '../../utils/format';
import { downloadDocument, openFile } from '../../utils/files';
import type { HrDocument } from '../../types';

// GET /documents already returns only what this role may see (company-wide
// documents, role-restricted ones, and the user's own). Uploading and editing
// stay on the web.
export function DocumentsScreen() {
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useInfiniteQuery({
    queryKey: keys.documents,
    queryFn: ({ pageParam }) => documentsApi.list(pageParam),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.limit < last.total ? last.page + 1 : undefined),
  });
  const rows = list.data?.pages.flatMap((page) => page.rows) ?? [];

  const open = async (doc: HrDocument) => {
    if (opening) return;
    if (!doc.fileRef) return setError(`"${doc.title}" has no file attached.`);
    setOpening(doc.id);
    setError(null);
    try {
      await openFile(await downloadDocument(doc));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not download "${doc.title}". You may not have access to it, or the connection dropped.`);
    } finally {
      setOpening(null);
    }
  };

  return (
    <FlatList
      style={layout.screen}
      contentContainerStyle={layout.content}
      data={rows}
      keyExtractor={(item) => item.id}
      ListHeaderComponent={error ? <Banner message={error} /> : null}
      refreshControl={<RefreshControl refreshing={list.isRefetching && !list.isFetchingNextPage} onRefresh={() => void list.refetch()} colors={[colors.primary]} />}
      onEndReached={() => { if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage(); }}
      onEndReachedThreshold={0.4}
      renderItem={({ item }) => (
        <Card style={{ paddingVertical: 0 }}>
          <Row
            icon={item.type === 'IMG' ? 'image-outline' : 'document-text-outline'}
            title={item.title}
            subtitle={[titleCase(item.folder), item.type, item.createdAt ? formatDate(item.createdAt) : null].filter(Boolean).join(' · ')}
            onPress={() => void open(item)}
            right={opening === item.id ? <ActivityIndicator color={colors.primary} /> : undefined}
          />
        </Card>
      )}
      ListEmptyComponent={
        list.isLoading ? <Loading />
          : list.isError ? <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
          : <EmptyState icon="folder-open-outline" title="No documents" message="Documents HR shares with you appear here." />
      }
    />
  );
}
