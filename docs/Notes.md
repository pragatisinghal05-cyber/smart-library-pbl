# Project notes - C runs the library engine, C++ runs users and recommendations.
- Hashing - id % 101 picks the slot; books in the same slot are chained.
- BST - titles are kept in A-Z order, smaller to the left, bigger to the right.
- Sorting - bubble sort orders books by title, author or popularity.
- Linked list - every book is a node; head points to the first book.
- Recommendation - unread books score +2 for same genre and +3 for same author.
- File handling - books, users and issues are saved as text files in data/.
- OOP - User is abstract; Student and Admin override menu() (polymorphism).
