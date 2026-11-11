export type ScopusInstitution = {
  id?: string | null;
  name?: string | null;
  parent?: string | null;
  parentName?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
};

export type ScopusAuthorProfile = {
  id: string;
  profile?: {
    preferredName?: string | null;
    preferredFirstName?: string | null;
    preferredLastName?: string | null;
    orcId?: string | null;
    emailAddress?: string | null;
    currentInstitution?: ScopusInstitution | null;
    institutionHistory?: Array<{
      name?: string | null;
      city?: string | null;
      state?: string | null;
      country?: string | null;
      dateRange?: string | null;
    }> | null;
  } | null;
  metrics?: {
    documentCount?: number | null;
    citationCount?: number | null;
    citedByCount?: number | null;
    hindex?: number | null;
    coAuthorsCount?: number | null;
  } | null;
};

export type AuthorProfileRow = {
  username: string;
  username_local: string;
  Name: string;
  scopus_id: string;
  resolved_scopus_id: string;
  affiliation: string;
  city: string;
  state: string;
  country: string;
  orcid: string;
  documents: string;
  citations: string;
  cited_by: string;
  h_index: string;
  coauthors: string;
  institution_history: string;
  status: "ok" | "empty_profile" | "not_found" | "missing";
};

export const PROFILE_COLUMNS: Array<keyof AuthorProfileRow> = [
  "username",
  "username_local",
  "Name",
  "scopus_id",
  "resolved_scopus_id",
  "affiliation",
  "city",
  "state",
  "country",
  "orcid",
  "documents",
  "citations",
  "cited_by",
  "h_index",
  "coauthors",
  "institution_history",
  "status",
];

export type ScopusDocumentItem = {
  eid?: string;
  scopusId?: string;
  doi?: string | null;
  title?: string;
  titles?: string[];
  pubYear?: string | number;
  documentType?: string;
  citations?: { count?: number };
  references?: { count?: number };
  totalAuthors?: number;
  authors?: Array<{
    authorId?: string;
    preferredName?: { first?: string; last?: string; full?: string };
    email?: string | null;
    affiliationReferences?: string[];
  }>;
  subjectAreas?: Array<{ code?: number; displayName?: string }>;
  source?: {
    id?: string;
    title?: string;
    publisher?: string;
    issn?: string;
    eissn?: string;
    sourceType?: string;
  };
  abstractText?: string[];
};

export type ScopusDocumentSearch = {
  metadata?: {
    offset?: number;
    totalCount?: number;
    itemCount?: number;
    numberOfPages?: number;
    message?: string;
    facets?: Record<string, unknown>;
  };
  items?: ScopusDocumentItem[];
};

export type ScopusJournalMetrics = {
  sourceId?: string;
  sourceTitle?: string;
  publisher?: string;
  sourceType?: string;
  metrics?: Array<{ name?: string; value?: string; year?: string }>;
};

export type ScopusCiteScore = Array<{
  subjectPercentage?: string;
  rank?: string;
  totalSourceCount?: string;
  subjectCode?: string;
  year?: string;
}>;

export type ScopusCiteScoreError = { code?: string };

export type JournalRecord = {
  id: string;
  journals: ScopusJournalMetrics | null;
  citescore: ScopusCiteScore | ScopusCiteScoreError | null;
};
