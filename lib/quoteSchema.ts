export interface QuoteItem {
  name: string;
  description: string;
}

export interface Client {
  name?: string;
  address?: string;
  phone?: string;
  email?: string;
}

export interface Quote {
  title: string;
  date: string;
  scope: string;
  industry: string;
  client: Client;
  items: QuoteItem[];
  total: number;
  has_tax: boolean;
  tax_amount?: number;
  warranty: string;
  terms: string;
  comments: string;
  status: "draft" | "complete";
}

export type PartialQuote = Partial<Omit<Quote, "client" | "items">> & {
  client?: Partial<Client>;
  items?: Partial<QuoteItem>[];
};
